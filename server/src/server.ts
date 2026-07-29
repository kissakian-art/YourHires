import express from 'express';
import cors from 'cors';
import { execSync } from 'child_process';
import { ensureDatabaseExists } from './db';
import { PrismaClient } from '@prisma/client';
import { streamInvoicePdf, streamBookingReceiptPdf, streamRentalOrderPdf } from './pdf';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { sendEmail, buildVerificationEmail, buildPasswordResetEmail, devEmailLog, CLIENT_URL } from './email';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 20090;
const API_BASE = process.env.API_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());

const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED === 'true';
const rateLimitRequests = parseInt(process.env.RATE_LIMIT_REQUESTS || '150');
const rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW || '60') * 1000; // in milliseconds

// Cache structure: ip -> { count, resetTime }
const rateLimitCache = new Map<string, { count: number; resetTime: number }>();

const rateLimitMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!rateLimitEnabled) {
    return next();
  }

  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown-ip';
  const now = Date.now();

  let clientData = rateLimitCache.get(ip);

  if (!clientData || now > clientData.resetTime) {
    clientData = {
      count: 0,
      resetTime: now + rateLimitWindow
    };
  }

  clientData.count++;
  rateLimitCache.set(ip, clientData);

  const remaining = Math.max(0, rateLimitRequests - clientData.count);
  const resetSeconds = Math.ceil((clientData.resetTime - now) / 1000);

  res.setHeader('X-RateLimit-Limit', rateLimitRequests);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', resetSeconds);

  if (clientData.count > rateLimitRequests) {
    return res.status(429).json({ error: 'Too many requests, please try again later.' });
  }

  next();
};

app.use(rateLimitMiddleware);

// Seeding function to populate database on initial run
async function seedDatabase() {
  const companyCount = await prisma.company.count();
  if (companyCount === 0) {
    console.log("Seeding initial database data...");
    
    // Create subscription plans
    const freePlan = await prisma.subscriptionPlan.create({
      data: {
        name: "Free Basic Tier",
        planType: "free",
        priceMonthly: 0.00,
        maxUsers: 2,
        maxItems: 20,
        isActive: true
      }
    });

    const profPlan = await prisma.subscriptionPlan.create({
      data: {
        name: "Professional Tier",
        planType: "professional",
        priceMonthly: 49000.00,
        maxUsers: 10,
        maxItems: 200,
        isActive: true
      }
    });

    const plan = await prisma.subscriptionPlan.create({
      data: {
        name: "Enterprise Plan",
        planType: "pro",
        priceMonthly: 150000.00,
        maxUsers: 50,
        maxItems: 5000,
        isActive: true
      }
    });

    // Create company
    const company = await prisma.company.create({
      data: {
        name: "Mega Rentals Uganda Ltd",
        publicSlug: "mega-rentals",
        planId: plan.id,
        currency: "UGX",
        isActive: true,
        publicBookingsEnabled: true,
        bookingExpirationHours: 24
      }
    });

    // Create Kampala Event Planners company
    const company2 = await prisma.company.create({
      data: {
        name: "Kampala Event Planners",
        publicSlug: "kampala-events",
        planId: plan.id,
        currency: "UGX",
        isActive: true,
        publicBookingsEnabled: true,
        bookingExpirationHours: 24
      }
    });

    // Create Users & UserProfiles
    const user1 = await prisma.user.create({
      data: {
        username: "admin",
        email: "admin@mega.ug",
        password: hashPassword("password123"),
        firstName: "Mega",
        lastName: "Admin"
      }
    });
    await prisma.userProfile.create({
      data: {
        userId: user1.id,
        companyId: company.id,
        role: "Admin"
      }
    });

    const user2 = await prisma.user.create({
      data: {
        username: "kampala_admin",
        email: "kampala@events.ug",
        password: hashPassword("password123"),
        firstName: "Kampala",
        lastName: "Admin"
      }
    });
    await prisma.userProfile.create({
      data: {
        userId: user2.id,
        companyId: company2.id,
        role: "Admin"
      }
    });

    const user3 = await prisma.user.create({
      data: {
        username: "staff",
        email: "staff@mega.ug",
        password: hashPassword("password123"),
        firstName: "Mega",
        lastName: "Staff"
      }
    });
    await prisma.userProfile.create({
      data: {
        userId: user3.id,
        companyId: company.id,
        role: "User"
      }
    });

    // Create default items
    const items = await Promise.all([
      prisma.item.create({ data: { companyId: company.id, name: "Executive Plastic Chairs", category: "Chairs", unitOfMeasure: "piece", unitCost: 10000, unitReplacementCost: 15000, dailyRentalRate: 2500, currentStock: 450 } }),
      prisma.item.create({ data: { companyId: company.id, name: "Banquet Decorated Chair", category: "Chairs", unitOfMeasure: "piece", unitCost: 25000, unitReplacementCost: 35000, dailyRentalRate: 5000, currentStock: 150 } }),
      prisma.item.create({ data: { companyId: company.id, name: "Double Pyramidal Tent (100-seater)", category: "Tents", unitOfMeasure: "piece", unitCost: 800000, unitReplacementCost: 1200000, dailyRentalRate: 150000, currentStock: 12 } }),
      prisma.item.create({ data: { companyId: company.id, name: "Sound System (Medium Event Pack)", category: "Sound", unitOfMeasure: "piece", unitCost: 3500000, unitReplacementCost: 4500000, dailyRentalRate: 350000, currentStock: 4 } }),
      prisma.item.create({ data: { companyId: company.id, name: "50kVA Silent Diesel Generator", category: "Power", unitOfMeasure: "piece", unitCost: 22000000, unitReplacementCost: 28000000, dailyRentalRate: 450000, currentStock: 2 } })
    ]);

    // Create Customer
    const customer = await prisma.customer.create({
      data: {
        companyId: company.id,
        name: "Sarah Kabasomi",
        contactInfo: "sarah@gmail.com, +256772123456",
        isOnWatchList: false
      }
    });

    // Create Booking
    await prisma.booking.create({
      data: {
        companyId: company.id,
        customerId: customer.id,
        bookingNumber: "B-2026-101",
        customerName: "Sarah Kabasomi",
        contactInfo: "sarah@gmail.com, +256772123456",
        bookingType: "customer",
        scheduledPickupDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days from now
        scheduledReturnDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
        estimatedTotalCost: 757500.00,
        depositAmount: 200000.00,
        depositPaid: true,
        depositPaidDate: new Date(),
        status: "confirmed"
      }
    });

    // Create active RentalOrder
    const order = await prisma.rentalOrder.create({
      data: {
        companyId: company.id,
        customerId: customer.id,
        customerName: "Sarah Kabasomi",
        checkoutDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
        expectedReturnDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago (overdue)
        status: "Active",
        companyOrderNumber: "RO-2026-809",
        isFinalized: false,
        totalAmountPaid: 200000.00,
        estimatedTotal: 757500.00
      }
    });

    // Create Unpaid Invoice matching remaining balance
    await prisma.invoice.create({
      data: {
        companyId: company.id,
        referenceNumber: "INV-2026-401",
        customerName: "Sarah Kabasomi",
        amount: 557500.00,
        dueDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        status: "Unpaid",
        description: "Balance on Rental Order #RO-2026-809"
      }
    });

    // Create Function Roles
    const roles = await Promise.all([
      prisma.functionRole.create({ data: { companyId: company.id, name: "Usher", description: "Responsible for guest welcoming and seating" } }),
      prisma.functionRole.create({ data: { companyId: company.id, name: "Service Coordinator", description: "Manages schedule and timeline of the event" } }),
      prisma.functionRole.create({ data: { companyId: company.id, name: "Sound Engineer", description: "Responsible for audio setups and microphones" } }),
      prisma.functionRole.create({ data: { companyId: company.id, name: "Logistics Crew", description: "Handles item loading and site assembly" } })
    ]);

    // Create Employees
    const employees = await Promise.all([
      prisma.employee.create({
        data: {
          companyId: company.id,
          name: "James Kigozi",
          role: "Usher Team Lead",
          billingRateToClient: 15000.00,
          payStructure: "Per Function",
          payRate: 8000.00,
          isActive: true
        }
      }),
      prisma.employee.create({
        data: {
          companyId: company.id,
          name: "Anita Namubiru",
          role: "Service Coordinator",
          billingRateToClient: 25000.00,
          payStructure: "Daily",
          payRate: 15000.00,
          isActive: true
        }
      }),
      prisma.employee.create({
        data: {
          companyId: company.id,
          name: "Peter Ochieng",
          role: "Sound Engineer",
          billingRateToClient: 35000.00,
          payStructure: "Per Function",
          payRate: 20000.00,
          isActive: true
        }
      })
    ]);

    // Create Job Sites
    const sites = await Promise.all([
      prisma.site.create({
        data: {
          companyId: company.id,
          name: "Speke Resort Munyonyo",
          location: "Munyonyo, Kampala",
          contactPerson: "Manager Isaac",
          contactInfo: "+256 701 445566",
          notes: "Requires generator setup on the lakeside lawns."
        }
      }),
      prisma.site.create({
        data: {
          companyId: company.id,
          name: "Sheraton Kampala Hotel",
          location: "Ternan Avenue, Kampala",
          contactPerson: "Esther Kemigisha",
          contactInfo: "+256 772 889900",
          notes: "Access from secondary cargo bay only."
        }
      })
    ]);

    // Assign Peter to Speke Resort Munyonyo
    await prisma.siteAssignment.create({
      data: {
        companyId: company.id,
        siteId: sites[0].id,
        employeeId: employees[2].id,
        isPrimary: true,
        notes: "Primary sound engineer for lakeside events"
      }
    });

    // Create a Function Event
    const eventDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // in 5 days
    const event = await prisma.functionEvent.create({
      data: {
        companyId: company.id,
        name: "Mukasa Memorial Ceremony",
        date: eventDate,
        time: "10:00 AM",
        location: "Speke Resort Munyonyo",
        clientName: "David Mukasa",
        clientContact: "+256 752 909090",
        notes: " lakeside lawn layout setup",
        status: "Scheduled"
      }
    });

    // Assign James and Anita to the event
    await prisma.functionAssignment.create({
      data: {
        companyId: company.id,
        functionId: event.id,
        employeeId: employees[0].id,
        roleId: roles[0].id,
        status: "Confirmed",
        startTime: "08:00 AM",
        endTime: "04:00 PM",
        notes: "Coordinate guest seating at lakeside gates."
      }
    });
    await prisma.functionAssignment.create({
      data: {
        companyId: company.id,
        functionId: event.id,
        employeeId: employees[1].id,
        roleId: roles[1].id,
        status: "Confirmed",
        startTime: "07:00 AM",
        endTime: "05:00 PM",
        notes: "Event manager. Synchronize program with Speke crew."
      }
    });

    // Create Suppliers
    const suppliers = await Promise.all([
      prisma.supplier.create({
        data: {
          companyId: company.id,
          name: "Elite Tent Manufacturers Ltd",
          contactPerson: "Mr. Moses Kintu",
          phone: "+256 702 334455",
          email: "sales@elitetents.co.ug",
          address: "Kibuye Road, Kampala",
          notes: "Lead time is 7 days for custom banners."
        }
      }),
      prisma.supplier.create({
        data: {
          companyId: company.id,
          name: "Standard Generator Parts Co.",
          contactPerson: "Eng. Ronald Mukasa",
          phone: "+256 782 112233",
          email: "info@stdgenparts.ug",
          address: "Industrial Area, Kampala",
          notes: "Net 15 terms."
        }
      })
    ]);

    // Create a Purchase Order
    await prisma.purchaseOrder.create({
      data: {
        companyId: company.id,
        supplierId: suppliers[0].id,
        poNumber: "PO-2026-901",
        orderDate: new Date().toISOString().split('T')[0],
        deliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        totalAmount: 6000000.00, // 5 x 1,200,000
        status: "Ordered",
        notes: "Restocking double pyramidal tents.",
        lineItems: {
          create: [
            {
              companyId: company.id,
              itemId: items[2].id, // Double Pyramidal Tent
              description: "Double Pyramidal Tent (100-seater) - Standard White PVC",
              quantity: 5,
              unitCost: 1200000,
              totalCost: 6000000
            }
          ]
        }
      }
    });

    // Create Expenses
    await Promise.all([
      prisma.expense.create({
        data: {
          companyId: company.id,
          supplierId: suppliers[1].id,
          amount: 150000.00,
          expenseCategory: "Fuel",
          expenseDate: new Date().toISOString().split('T')[0],
          paymentMethod: "Mobile Money",
          notes: "Fuel for 50kVA generator setup at Munyonyo."
        }
      }),
      prisma.expense.create({
        data: {
          companyId: company.id,
          amount: 800000.00,
          expenseCategory: "Rent",
          expenseDate: new Date().toISOString().split('T')[0],
          paymentMethod: "Bank Transfer",
          notes: "July monthly warehouse space rental."
        }
      })
    ]);

    // Create a Payroll Period
    const startWeek = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const payrollPeriod = await prisma.payrollPeriod.create({
      data: {
        companyId: company.id,
        startDate: startWeek,
        endDate: endWeek,
        status: "Open",
        totalSpent: 23000.00
      }
    });

    // Create payroll payments
    await Promise.all([
      prisma.payrollPayment.create({
        data: {
          companyId: company.id,
          payrollPeriodId: payrollPeriod.id,
          employeeId: employees[0].id,
          amount: 8000.00,
          status: "Unpaid",
          notes: `Event: "Mukasa Memorial Ceremony" (Per Function @ UGX 8,000)`
        }
      }),
      prisma.payrollPayment.create({
        data: {
          companyId: company.id,
          payrollPeriodId: payrollPeriod.id,
          employeeId: employees[1].id,
          amount: 15000.00,
          status: "Unpaid",
          notes: `Date: ${eventDate} (Daily Pay @ UGX 15,000)`
        }
      })
    ]);

    // Create default audit logs
    await Promise.all([
      prisma.auditLog.create({
        data: {
          companyId: company.id,
          username: "admin",
          action: "EMAIL_DISPATCH",
          modelName: "Booking",
          objectId: 1,
          objectRepr: "B-2026-9901",
          additionalInfo: `Simulated booking confirmation email dispatched to Sarah Kabasomi (Sarah.k@gmail.com). Estimated Total: UGX 1,500,000, Deposit: UGX 300,000.`
        }
      }),
      prisma.auditLog.create({
        data: {
          companyId: company.id,
          username: "admin",
          action: "EMAIL_DISPATCH",
          modelName: "Invoice",
          objectId: 1,
          objectRepr: "INV-2026-8802",
          additionalInfo: `Simulated invoice payment receipt email dispatched to Sarah Kabasomi. Amount Paid: UGX 300,000 via Cash. notes: Seed deposit payment.`
        }
      })
    ]);

    console.log("Seeding completed successfully.");
  }
}

// Helper: Calculate days between dates
function getDaysBetween(start: Date, end: Date): number {
  const diff = end.getTime() - start.getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 1;
}

// Endpoints

// 1. Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'YourHires API Service' });
});

app.get('/api/config', (req, res) => {
  res.json({
    sessionCookieAge: parseInt(process.env.SESSION_COOKIE_AGE || '600'),
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED === 'true'
  });
});


async function logAudit(companyId: number, username: string, action: string, modelName: string, objectId: number | null, objectRepr: string, message: string) {
  try {
    const entry = await prisma.auditLog.create({
      data: {
        companyId,
        username,
        action,
        modelName,
        objectId,
        objectRepr,
        additionalInfo: message
      }
    });
    console.log(`[AUDIT LOG] ${action} on ${modelName} (${objectRepr}): ${message}`);
    return entry;
  } catch (err: any) {
    console.error("Failed to write audit log:", err.message);
  }
}

// ── AUTH HELPERS ─────────────────────────────────────────────────────────
const BCRYPT_ROUNDS = 10;
// bcrypt hashes start with $2a$ / $2b$ / $2y$; used to tell hashed from legacy plaintext.
function isBcryptHash(v: string) { return /^\$2[aby]\$/.test(v || ''); }
function hashPassword(pw: string) { return bcrypt.hashSync(pw, BCRYPT_ROUNDS); }
// Verifies a password, transparently supporting legacy plaintext records.
function passwordMatches(plain: string, stored: string) {
  return isBcryptHash(stored) ? bcrypt.compareSync(plain, stored) : plain === stored;
}
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

// Issues a single-use auth token (email verification / password reset).
async function issueAuthToken(userId: number, purpose: 'email_verification' | 'password_reset', ttlMs: number) {
  // Invalidate any outstanding tokens of the same purpose for this user.
  await prisma.authToken.deleteMany({ where: { userId, purpose, usedAt: null } });
  const token = makeToken();
  await prisma.authToken.create({
    data: { userId, token, purpose, expiresAt: new Date(Date.now() + ttlMs) }
  });
  return token;
}

// ── CUSTOMER LEDGER HELPER FUNCTIONS ─────────────────────────────────────

async function resolveCustomerByName(customerName: string, companyId: number, contactInfo: string = '') {
  let customer = await prisma.customer.findFirst({
    where: {
      companyId,
      name: customerName.trim()
    }
  });
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        companyId,
        name: customerName.trim(),
        contactInfo: contactInfo || '',
        isOnWatchList: false
      }
    });
  }
  return customer;
}

async function getOrCreateCustomerAccount(customerId: number, companyId: number) {
  let account = await prisma.customerAccount.findUnique({
    where: { customerId }
  });
  if (!account) {
    account = await prisma.customerAccount.create({
      data: {
        customerId,
        creditLimit: 0,
        paymentTermsDays: 30,
        totalOutstanding: 0,
        totalOverdue: 0,
        currentBalance: 0,
        balance31_60: 0,
        balance61_90: 0,
        balanceOver90: 0
      }
    });
  }
  return account;
}

async function recalculateCustomerBalance(customerId: number, companyId: number) {
  const account = await getOrCreateCustomerAccount(customerId, companyId);

  // Get all transactions for this account sorted chronologically
  const transactions = await prisma.customerAccountTransaction.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: 'asc' }
  });

  let totalOutstanding = 0;
  let lastPaymentDate: Date | null = null;
  let lastPaymentAmount = 0;

  // Process transactions chronologically to update running balance_after_transaction
  for (const tx of transactions) {
    const amount = Number(tx.amount);
    totalOutstanding += amount;

    await prisma.customerAccountTransaction.update({
      where: { id: tx.id },
      data: { balanceAfterTransaction: totalOutstanding }
    });

    // Track last payment info (credits)
    if (amount < 0) {
      if (!lastPaymentDate || tx.createdAt > lastPaymentDate) {
        lastPaymentDate = tx.createdAt;
        lastPaymentAmount = Math.abs(amount);
      }
    }
  }

  // Calculate aging buckets based on unpaid debits
  let currentBalance = 0;
  let balance31_60 = 0;
  let balance61_90 = 0;
  let balanceOver90 = 0;
  let totalOverdue = 0;

  // Get all debit transactions (charges, invoices, late fees, adjustments > 0)
  const debits = transactions.filter(tx => Number(tx.amount) > 0);

  let runningBalance = totalOutstanding;
  const now = new Date();

  // Sort debits by due date or created date to allocate payments (FIFO/outstanding allocation)
  const sortedDebits = debits.sort((a, b) => {
    const dateA = a.dueDate ? new Date(a.dueDate).getTime() : a.createdAt.getTime();
    const dateB = b.dueDate ? new Date(b.dueDate).getTime() : b.createdAt.getTime();
    return dateA - dateB;
  });

  for (const debit of sortedDebits) {
    if (runningBalance <= 0) break;

    const debitAmount = Number(debit.amount);
    const debitOutstanding = Math.min(debitAmount, runningBalance);

    if (debit.dueDate) {
      const dueDate = new Date(debit.dueDate);
      const diffTime = now.getTime() - dueDate.getTime();
      const daysOld = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (daysOld > 0) {
        totalOverdue += debitOutstanding;
      }

      if (daysOld <= 30) {
        currentBalance += debitOutstanding;
      } else if (daysOld <= 60) {
        balance31_60 += debitOutstanding;
      } else if (daysOld <= 90) {
        balance61_90 += debitOutstanding;
      } else {
        balanceOver90 += debitOutstanding;
      }
    } else {
      // No due date goes to current
      currentBalance += debitOutstanding;
    }

    runningBalance -= debitOutstanding;
  }

  // Save the updated account details
  const updatedAccount = await prisma.customerAccount.update({
    where: { id: account.id },
    data: {
      totalOutstanding: Math.max(0, totalOutstanding),
      totalOverdue: Math.max(0, totalOverdue),
      currentBalance: Math.max(0, currentBalance),
      balance31_60: Math.max(0, balance31_60),
      balance61_90: Math.max(0, balance61_90),
      balanceOver90: Math.max(0, balanceOver90),
      // update payment metadata
      // (Prisma requires a Date object or null for lastPaymentDate)
      ...(lastPaymentDate ? { lastPaymentDate } : {})
    }
  });

  return updatedAccount;
}

async function createAccountTransaction(params: {
  customerId: number;
  companyId: number;
  transactionType: string; // 'invoice' | 'payment' | 'credit_memo' | 'adjustment' | 'refund' | 'late_fee' | 'damage_fee' | 'booking_deposit'
  amount: number; // positive for debits, negative for credits
  description: string;
  dueDate?: Date;
  referenceNumber?: string;
}) {
  const account = await getOrCreateCustomerAccount(params.customerId, params.companyId);

  // Create the transaction
  const tx = await prisma.customerAccountTransaction.create({
    data: {
      accountId: account.id,
      transactionType: params.transactionType,
      amount: params.amount,
      balanceAfterTransaction: 0, // will be recalculated
      description: params.description,
      dueDate: params.dueDate || null,
      referenceNumber: params.referenceNumber || null
    }
  });

  // Recalculate balances
  await recalculateCustomerBalance(params.customerId, params.companyId);

  return tx;
}

// Helper to record cash inflows to the Consolidated Revenue Ledger
async function recordIncome(params: {
  companyId: number;
  incomeSource: string;
  amount: number;
  paymentMethod: string;
  description: string;
  referenceNumber?: string;
  baseRentalAmount?: number;
  lateFeeAmount?: number;
  damageFeeAmount?: number;
  depositAmount?: number;
  otherFeeAmount?: number;
}) {
  try {
    const company = await prisma.company.findUnique({
      where: { id: params.companyId }
    });
    const currency = company?.currency || 'UGX';

    const record = await prisma.income.create({
      data: {
        companyId: params.companyId,
        currency,
        incomeSource: params.incomeSource,
        amount: params.amount,
        paymentMethod: params.paymentMethod,
        referenceNumber: params.referenceNumber || null,
        description: params.description,
        baseRentalAmount: params.baseRentalAmount || 0,
        lateFeeAmount: params.lateFeeAmount || 0,
        damageFeeAmount: params.damageFeeAmount || 0,
        depositAmount: params.depositAmount || 0,
        otherFeeAmount: params.otherFeeAmount || 0
      }
    });
    return record;
  } catch (err) {
    console.error('Failed to record ledger income:', err);
    return null;
  }
}

// ── RETURN / RECONCILIATION HELPERS ──────────────────────────────────────

// Single source of truth for the late-fee formula, shared by the return and
// apply-late-fee endpoints (previously they used two divergent formulas).
// Fee = Σ (dailyRate × lateFeePercentPerDay% × daysOverdue × rentedQty).
function computeLateFee(
  lineItems: { dailyRate: any; rentedQty: number }[],
  expectedReturnDate: Date | string,
  asOf: Date,
  lateFeePercentPerDay: number
): { lateFee: number; daysOverdue: number } {
  const daysOverdue = Math.max(0, Math.ceil(
    (asOf.getTime() - new Date(expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
  ));
  if (daysOverdue <= 0) return { lateFee: 0, daysOverdue: 0 };
  const rate = (Number(lateFeePercentPerDay) || 0) / 100;
  const lateFee = lineItems.reduce(
    (sum, li) => sum + Number(li.dailyRate) * rate * daysOverdue * (li.rentedQty || 0),
    0
  );
  return { lateFee: Math.round(lateFee), daysOverdue };
}

// Idempotent penalty/charge invoice keyed by a deterministic reference, so
// re-applying a fee updates the existing invoice instead of duplicating it.
async function upsertPenaltyInvoice(
  companyId: number, ref: string, customerName: string,
  amount: number, description: string, dueDate: Date
) {
  const existing = await prisma.invoice.findFirst({ where: { companyId, referenceNumber: ref } });
  if (existing) {
    return prisma.invoice.update({
      where: { id: existing.id },
      data: {
        amount: Math.round(amount), dueDate, description,
        status: existing.status === 'Paid' ? 'Paid' : 'Unpaid'
      }
    });
  }
  return prisma.invoice.create({
    data: {
      companyId, referenceNumber: ref, customerName,
      amount: Math.round(amount), dueDate, status: 'Unpaid', description
    }
  });
}

// Idempotent ledger charge keyed by (type, reference): clears any prior charge
// with the same key then re-adds the current amount.
async function chargeLedgerOnce(
  customerId: number, companyId: number, transactionType: string,
  ref: string, amount: number, description: string, dueDate: Date
) {
  const account = await getOrCreateCustomerAccount(customerId, companyId);
  await prisma.customerAccountTransaction.deleteMany({
    where: { accountId: account.id, transactionType, referenceNumber: ref }
  });
  if (amount > 0) {
    await createAccountTransaction({
      customerId, companyId, transactionType,
      amount: Math.round(amount), description, dueDate, referenceNumber: ref
    });
  } else {
    await recalculateCustomerBalance(customerId, companyId);
  }
}

// ── NOTIFICATIONS ──────────────────────────────────────────────────────────

// Create an in-app notification. `dedupeLink` (optional) prevents piling up
// duplicate unread notifications for the same subject (e.g. the overdue scanner
// re-running, or repeated low-stock dips on the same item).
async function createNotification(params: {
  companyId: number; category: string; title: string; message: string;
  link?: string; dedupe?: boolean;
}) {
  try {
    if (params.dedupe && params.link) {
      const existing = await prisma.notification.findFirst({
        where: { companyId: params.companyId, category: params.category, link: params.link, isRead: false }
      });
      if (existing) {
        // Refresh the existing unread notification instead of adding another.
        await prisma.notification.update({
          where: { id: existing.id },
          data: { title: params.title, message: params.message, createdAt: new Date() }
        });
        return existing;
      }
    }
    return await prisma.notification.create({
      data: {
        companyId: params.companyId, category: params.category,
        title: params.title, message: params.message, link: params.link || null
      }
    });
  } catch (err: any) {
    console.error('Failed to create notification:', err.message);
    return null;
  }
}

// Raise a low-stock notification if an item has dipped to/below its threshold.
async function checkItemLowStock(itemId: number, companyId: number) {
  try {
    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) return;
    if (item.currentStock <= item.lowStockThreshold) {
      await createNotification({
        companyId, category: 'low_stock',
        title: `Low stock: ${item.name}`,
        message: `${item.name} is down to ${item.currentStock} unit(s) (threshold ${item.lowStockThreshold}). Consider restocking.`,
        link: `item-${item.id}`, dedupe: true,
      });
    }
  } catch { /* non-fatal */ }
}

app.get('/api/audit-logs', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.auditLog.findMany({
      where: { companyId },
      orderBy: { id: 'desc' },
      take: 50
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List notifications for the company (+ unread count)
app.get('/api/notifications', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const [list, unread] = await Promise.all([
      prisma.notification.findMany({ where: { companyId }, orderBy: { id: 'desc' }, take: 100 }),
      prisma.notification.count({ where: { companyId, isRead: false } }),
    ]);
    res.json({ notifications: list, unread });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight unread-count poll
app.get('/api/notifications/count', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const unread = await prisma.notification.count({ where: { companyId, isRead: false } });
    res.json({ unread });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Mark one notification read
app.post('/api/notifications/:id/read', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    await prisma.notification.updateMany({ where: { id, companyId }, data: { isRead: true } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Mark all read
app.post('/api/notifications/mark-all-read', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    await prisma.notification.updateMany({ where: { companyId, isRead: false }, data: { isRead: true } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Per-user notification preferences (userId identifies the team member)
app.get('/api/notifications/preferences', async (req, res) => {
  const userId = parseInt(req.query.userId as string);
  if (!userId) return res.status(400).json({ error: 'userId is required.' });
  try {
    let prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
    if (!prefs) prefs = await prisma.notificationPreference.create({ data: { userId } });
    res.json(prefs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notifications/preferences', async (req, res) => {
  const { userId, overdue, lowStock, returns, payments, bookings } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required.' });
  try {
    const data: any = {};
    for (const [k, v] of Object.entries({ overdue, lowStock, returns, payments, bookings })) {
      if (v !== undefined) data[k] = !!v;
    }
    const prefs = await prisma.notificationPreference.upsert({
      where: { userId: parseInt(userId) },
      update: data,
      create: { userId: parseInt(userId), ...data },
    });
    res.json(prefs);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── GLOBAL SEARCH ──────────────────────────────────────────────────────────
// Searches across the main entities and returns grouped results, each pointing
// at the client tab that renders it. MySQL's default collation is case-insensitive.
app.get('/api/search', async (req, res) => {
  const companyId = getCompanyId(req);
  const q = (req.query.q as string || '').trim();
  if (q.length < 2) return res.json({ groups: [], total: 0 });
  const like = { contains: q };
  const TAKE = 6;
  try {
    const [customers, orders, bookings, items, assets, invoices, employees] = await Promise.all([
      prisma.customer.findMany({ where: { companyId, OR: [{ name: like }, { contactInfo: like }] }, take: TAKE }),
      prisma.rentalOrder.findMany({ where: { companyId, OR: [{ companyOrderNumber: like }, { customerName: like }] }, take: TAKE, orderBy: { id: 'desc' } }),
      prisma.booking.findMany({ where: { companyId, OR: [{ bookingNumber: like }, { customerName: like }] }, take: TAKE, orderBy: { id: 'desc' } }),
      prisma.item.findMany({ where: { companyId, OR: [{ name: like }, { category: like }] }, take: TAKE }),
      prisma.serializedAsset.findMany({ where: { companyId, OR: [{ name: like }, { serialNumber: like }, { assetType: like }] }, take: TAKE }),
      prisma.invoice.findMany({ where: { companyId, OR: [{ referenceNumber: like }, { customerName: like }] }, take: TAKE, orderBy: { id: 'desc' } }),
      prisma.employee.findMany({ where: { companyId, OR: [{ name: like }, { role: like }] }, take: TAKE }),
    ]);

    const groups = [
      { type: 'customers', label: 'Customers', tab: 'customers', items: customers.map(c => ({ id: c.id, label: c.name, sublabel: c.contactInfo || '' })) },
      { type: 'orders', label: 'Rental Orders', tab: 'dispatches', items: orders.map(o => ({ id: o.id, label: o.companyOrderNumber, sublabel: `${o.customerName} · ${o.status}` })) },
      { type: 'bookings', label: 'Bookings', tab: 'bookings', items: bookings.map(b => ({ id: b.id, label: b.bookingNumber, sublabel: `${b.customerName} · ${b.status}` })) },
      { type: 'items', label: 'Items', tab: 'inventory', items: items.map(i => ({ id: i.id, label: i.name, sublabel: `${i.category} · ${i.currentStock} in stock` })) },
      { type: 'assets', label: 'Serialized Assets', tab: 'inventory', items: assets.map(a => ({ id: a.id, label: a.name, sublabel: `${a.serialNumber} · ${a.status}` })) },
      { type: 'invoices', label: 'Invoices', tab: 'invoices', items: invoices.map(i => ({ id: i.id, label: i.referenceNumber, sublabel: `${i.customerName} · ${i.status}` })) },
      { type: 'employees', label: 'Staff', tab: 'scheduling', items: employees.map(e => ({ id: e.id, label: e.name, sublabel: e.role || 'Staff' })) },
    ].filter(g => g.items.length > 0);

    const total = groups.reduce((s, g) => s + g.items.length, 0);
    res.json({ groups, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── SAVED SEARCHES ─────────────────────────────────────────────────────────
app.get('/api/saved-searches', async (req, res) => {
  const companyId = getCompanyId(req);
  const userId = parseInt(req.query.userId as string) || null;
  try {
    const list = await prisma.savedSearch.findMany({
      where: { companyId, ...(userId ? { userId } : {}) },
      orderBy: { id: 'desc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/saved-searches', async (req, res) => {
  const companyId = getCompanyId(req);
  const { userId, name, query } = req.body;
  if (!name || !query) return res.status(400).json({ error: 'name and query are required.' });
  try {
    const saved = await prisma.savedSearch.create({
      data: { companyId, userId: userId ? parseInt(userId) : null, name: String(name).slice(0, 100), query: String(query).slice(0, 255) },
    });
    res.status(201).json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/saved-searches/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    await prisma.savedSearch.deleteMany({ where: { id: parseInt(req.params.id), companyId } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── SETUP CHECKLIST / ONBOARDING ────────────────────────────────────────────
// Steps are derived live from real data rather than tracked separately, so the
// checklist can never drift out of sync with what the company has actually done.
app.get('/api/onboarding/status', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });

    const [itemCount, assetCount, customerCount, bookingCount, orderCount, teamCount] = await Promise.all([
      prisma.item.count({ where: { companyId } }),
      prisma.serializedAsset.count({ where: { companyId } }),
      prisma.customer.count({ where: { companyId } }),
      prisma.booking.count({ where: { companyId } }),
      prisma.rentalOrder.count({ where: { companyId } }),
      prisma.userProfile.count({ where: { companyId } }),
    ]);

    const steps = [
      { id: 'catalog', label: 'Add your first item or asset', tab: 'inventory', done: (itemCount + assetCount) > 0 },
      { id: 'customer', label: 'Add a customer', tab: 'customers', done: customerCount > 0 },
      { id: 'booking', label: 'Create your first booking or rental order', tab: 'bookings', done: (bookingCount + orderCount) > 0 },
      { id: 'team', label: 'Invite a team member', tab: 'settings', done: teamCount > 1 },
      { id: 'public', label: 'Enable public bookings for your catalog', tab: 'settings', done: company.publicBookingsEnabled },
    ];

    const completedCount = steps.filter(s => s.done).length;
    const percent = Math.round((completedCount / steps.length) * 100);

    // Auto-complete once every step is satisfied (idempotent).
    let dismissed = company.onboardingComplete;
    if (percent === 100 && !dismissed) {
      await prisma.company.update({ where: { id: companyId }, data: { onboardingComplete: true } });
      dismissed = true;
    }

    res.json({ steps, percent, completedCount, total: steps.length, dismissed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Let the user hide the checklist even if not all steps are done yet.
app.post('/api/onboarding/dismiss', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    await prisma.company.update({ where: { id: companyId }, data: { onboardingComplete: true } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/subscription-plans', async (req, res) => {
  try {
    const list = await prisma.subscriptionPlan.findMany({
      where: { isActive: true }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/subscription/upgrade', async (req, res) => {
  const { companyId, planId, cardHolderName } = req.body;
  if (!companyId || !planId) {
    return res.status(400).json({ error: 'companyId and planId are required.' });
  }
  try {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: parseInt(planId) }
    });
    if (!plan) return res.status(404).json({ error: 'Subscription Plan not found.' });

    const company = await prisma.company.update({
      where: { id: parseInt(companyId) },
      data: { planId: plan.id },
      include: { plan: true }
    });

    await logAudit(
      company.id,
      'admin',
      'STRIPE_UPGRADE',
      'Company',
      company.id,
      company.name,
      `Simulated Stripe subscription payment confirmed for Professional/Enterprise plan [${plan.name}]. Cardholder: ${cardHolderName || 'Billing Account'}. Amount Billed: UGX ${Number(plan.priceMonthly).toLocaleString()}/month.`
    );

    res.json(company);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/public/:companySlug/catalog', async (req, res) => {
  const { companySlug } = req.params;
  try {
    const company = await prisma.company.findFirst({
      where: { publicSlug: companySlug, isActive: true, publicBookingsEnabled: true }
    });
    if (!company) {
      return res.status(404).json({ error: 'Company catalog not found or bookings disabled.' });
    }
    const items = await prisma.item.findMany({
      where: { companyId: company.id }
    });
    res.json({ company, items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/:companySlug/bookings', async (req, res) => {
  const { companySlug } = req.params;
  const { customerName, contactInfo, bookingType, scheduledPickupDate, scheduledReturnDate, lineItems } = req.body;
  
  if (!customerName || !lineItems || lineItems.length === 0) {
    return res.status(400).json({ error: 'Customer name and line items are required.' });
  }

  try {
    const company = await prisma.company.findFirst({
      where: { publicSlug: companySlug, isActive: true, publicBookingsEnabled: true }
    });
    if (!company) {
      return res.status(404).json({ error: 'Company catalog not found or bookings disabled.' });
    }

    let estimatedTotal = 0;
    const parsedPickup = scheduledPickupDate ? new Date(scheduledPickupDate) : new Date();
    const parsedReturn = scheduledReturnDate ? new Date(scheduledReturnDate) : new Date(Date.now() + 86400000);
    const days = getDaysBetween(parsedPickup, parsedReturn);

    const lineItemsWithRates = await Promise.all(lineItems.map(async (item: any) => {
      const dbItem = await prisma.item.findUnique({ where: { id: parseInt(item.itemId) } });
      if (!dbItem) throw new Error(`Item ${item.itemId} not found in catalog.`);
      
      const dailyRate = Number(dbItem.dailyRentalRate);
      const lineCost = dailyRate * item.quantity * days;
      estimatedTotal += lineCost;

      return {
        itemType: 'Item',
        itemId: dbItem.id,
        quantity: item.quantity,
        dailyRateAtBooking: dailyRate,
        estimatedRentalDays: days,
        estimatedLineTotal: lineCost
      };
    }));

    const rand = Math.floor(1000 + Math.random() * 9000);
    const bookingNumber = `B-PUB-${parsedPickup.getFullYear()}-${rand}`;

    const booking = await prisma.booking.create({
      data: {
        companyId: company.id,
        customerName,
        contactInfo,
        bookingType: bookingType || 'pickup',
        scheduledPickupDate: parsedPickup,
        scheduledReturnDate: parsedReturn,
        estimatedTotalCost: estimatedTotal,
        depositAmount: estimatedTotal * 0.2,
        bookingNumber,
        status: 'pending',
        lineItems: {
          create: lineItemsWithRates.map(li => ({
            itemType: li.itemType,
            itemId: li.itemId,
            quantity: li.quantity,
            dailyRateAtBooking: li.dailyRateAtBooking,
            estimatedRentalDays: li.estimatedRentalDays,
            estimatedLineTotal: li.estimatedLineTotal
          }))
        }
      }
    });

    await logAudit(
      company.id,
      'anonymous',
      'PUBLIC_BOOKING',
      'Booking',
      booking.id,
      bookingNumber,
      `Public reservation submitted by ${customerName}. Estimated Total: UGX ${estimatedTotal.toLocaleString()}, Deposit required: UGX ${(estimatedTotal * 0.2).toLocaleString()}.`
    );

    res.json(booking);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Global sitemap index: one entry per active, publicly-bookable company catalog.
// This is what search engines discover at the domain root; each entry points at
// that company's own /public/:slug/sitemap.xml (which lists the catalog + items).
app.get('/sitemap.xml', async (req, res) => {
  try {
    const companies = await prisma.company.findMany({
      where: { isActive: true, publicBookingsEnabled: true },
      select: { publicSlug: true },
    });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    companies.forEach(c => {
      xml += `\n    <sitemap>\n        <loc>${baseUrl}/public/${c.publicSlug}/sitemap.xml</loc>\n    </sitemap>`;
    });
    xml += `\n</sitemapindex>`;
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Global robots.txt at the domain root — where crawlers look by default.
// Points at the sitemap index above; the dashboard app and API are not indexable.
app.get('/robots.txt', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const robots = `User-agent: *
Allow: /public/
Disallow: /api/
Disallow: /admin/

Sitemap: ${baseUrl}/sitemap.xml
`;
  res.header('Content-Type', 'text/plain');
  res.send(robots);
});

app.get('/public/:companySlug/sitemap.xml', async (req, res) => {
  const { companySlug } = req.params;
  try {
    const company = await prisma.company.findFirst({
      where: { publicSlug: companySlug, isActive: true }
    });
    if (!company) return res.status(404).send('Company not found');

    const items = await prisma.item.findMany({
      where: { companyId: company.id }
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const catalogUrl = `${baseUrl}/public/${companySlug}`;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>${catalogUrl}</loc>
        <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>`;

    items.forEach(item => {
      xml += `
    <url>
        <loc>${baseUrl}/public/${companySlug}/item/${item.id}</loc>
        <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>`;
    });

    xml += `\n</urlset>`;
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

app.get('/public/:companySlug/robots.txt', async (req, res) => {
  const { companySlug } = req.params;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  const robots = `User-agent: *
Allow: /public/${companySlug}
Disallow: /api/
Disallow: /admin/

Sitemap: ${baseUrl}/public/${companySlug}/sitemap.xml
`;
  res.header('Content-Type', 'text/plain');
  res.send(robots);
});

function getCompanyId(req: any): number {
  const headerVal = req.headers['x-company-id'];
  if (headerVal) {
    const parsed = parseInt(headerVal as string);
    if (!isNaN(parsed)) return parsed;
  }
  // Fallback for links opened directly in a new tab (e.g. PDF downloads via
  // window.open) where a custom header can't be attached.
  const queryVal = req.query?.companyId;
  if (queryVal) {
    const parsed = parseInt(queryVal as string);
    if (!isNaN(parsed)) return parsed;
  }
  return 1;
}

// ── AUTHENTICATION ─────────────────────────────────────────────────────

// 0. Check username availability
app.get('/api/auth/check-username', async (req, res) => {
  const { username } = req.query as { username: string };
  if (!username || username.length < 3) {
    return res.json({ available: false, reason: 'Username must be at least 3 characters.' });
  }
  try {
    const existing = await prisma.user.findUnique({ where: { username } });
    res.json({ available: !existing, reason: existing ? 'Username is already taken.' : 'Username is available!' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 0b. Register new company + admin user (30-day free trial)
app.post('/api/auth/register', async (req, res) => {
  const {
    companyName, industry, address, phone,
    country, currency, currencySymbol, timezone,
    firstName, lastName, email, username, password
  } = req.body;

  if (!companyName || !firstName || !lastName || !email || !username || !password) {
    return res.status(400).json({ error: 'All required fields must be filled.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    // Check uniqueness
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] }
    });
    if (existingUser) {
      return res.status(409).json({ error: 'A user with that username or email already exists.' });
    }

    // Derive public slug from company name
    const slug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 80) + '-' + Date.now().toString().slice(-5);

    // Find or use free plan
    let freePlan = await prisma.subscriptionPlan.findFirst({ where: { planType: 'free' } });
    if (!freePlan) {
      freePlan = await prisma.subscriptionPlan.create({
        data: { name: 'Free Trial', planType: 'free', priceMonthly: 0, maxUsers: 3, maxItems: 50 }
      });
    }

    // Trial period: 30 days
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    // Create company
    const company = await prisma.company.create({
      data: {
        name: companyName,
        email,
        phone: phone || null,
        address: address || null,
        country: country || 'UG',
        currency: currency || 'UGX',
        currencySymbol: currencySymbol || currency || 'UGX',
        timezone: timezone || 'Africa/Kampala',
        industry: industry || 'Equipment Rental',
        planId: freePlan.id,
        publicSlug: slug,
        publicBookingsEnabled: true,
        trialActive: true,
        trialEndsAt,
        onboardingComplete: false
      },
      include: { plan: true }
    });

    // Create admin user (password hashed with bcrypt)
    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashPassword(password),
        firstName,
        lastName,
        isActive: true,
        emailVerified: false
      }
    });

    // Create admin profile
    await prisma.userProfile.create({
      data: { userId: user.id, companyId: company.id, role: 'Admin' }
    });

    // Issue a verification token and send the welcome / verify email.
    const verifyToken = await issueAuthToken(user.id, 'email_verification', 24 * 60 * 60 * 1000);
    await sendEmail(buildVerificationEmail(email, firstName, `${API_BASE}/api/auth/verify-email?token=${verifyToken}`));

    // Calculate trial days left
    const now = new Date();
    const trialDaysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    res.status(201).json({
      message: 'Account created successfully.',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: 'Admin',
        emailVerified: false
      },
      company: {
        ...company,
        trialDaysLeft
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 1. Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { username }
    });

    if (!user || !passwordMatches(password, user.password)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
    }
    // Opportunistically upgrade any legacy plaintext password to a bcrypt hash.
    if (!isBcryptHash(user.password)) {
      await prisma.user.update({ where: { id: user.id }, data: { password: hashPassword(password) } });
    }

    const profile = await prisma.userProfile.findUnique({
      where: { userId: user.id },
      include: {
        company: {
          include: {
            plan: true
          }
        }
      }
    });

    // Calculate trial info
    let trialDaysLeft = 0;
    if (profile?.company?.trialEndsAt) {
      const now = new Date();
      trialDaysLeft = Math.max(0, Math.ceil(
        (new Date(profile.company.trialEndsAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      ));
    }

    const companyData = profile?.company
      ? { ...profile.company, trialDaysLeft }
      : null;

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: profile?.role || 'User',
        emailVerified: user.emailVerified
      },
      company: companyData
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── EMAIL VERIFICATION & PASSWORD RESET ────────────────────────────────────

// Small self-contained HTML page (verification links in email open this directly).
function authResultPage(ok: boolean, title: string, message: string) {
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title></head>
  <body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
    <div style="max-width:440px;background:#fff;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden;text-align:center;">
      <div style="height:6px;background:${color};"></div>
      <div style="padding:36px 32px;">
        <h1 style="margin:0 0 6px;font-size:20px;color:#0f172a;">YourHires</h1>
        <div style="font-size:40px;margin:14px 0;">${ok ? '✅' : '⚠️'}</div>
        <h2 style="font-size:18px;color:${color};margin:0 0 8px;">${title}</h2>
        <p style="font-size:14px;color:#475569;">${message}</p>
        <a href="${CLIENT_URL}" style="display:inline-block;margin-top:18px;background:#2563eb;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:10px 22px;border-radius:8px;">Go to YourHires</a>
      </div>
    </div>
  </body></html>`;
}

// Verify email — opened from the link in the verification email.
app.get('/api/auth/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  try {
    const record = await prisma.authToken.findUnique({ where: { token } });
    if (!record || record.purpose !== 'email_verification' || record.usedAt || record.expiresAt < new Date()) {
      return res.status(400).send(authResultPage(false, 'Link invalid or expired', 'Please request a new verification email from your account.'));
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } }),
      prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    res.send(authResultPage(true, 'Email verified', 'Your email address has been confirmed. You can now sign in.'));
  } catch (err: any) {
    res.status(500).send(authResultPage(false, 'Something went wrong', 'Please try again later.'));
  }
});

// Resend verification email
app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email: String(email || '') } });
    // Always report success (avoid leaking which emails exist).
    if (user && !user.emailVerified) {
      const token = await issueAuthToken(user.id, 'email_verification', 24 * 60 * 60 * 1000);
      await sendEmail(buildVerificationEmail(user.email, user.firstName || 'there', `${API_BASE}/api/auth/verify-email?token=${token}`));
    }
    res.json({ message: 'If that email is registered and unverified, a new verification link has been sent.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Request a password reset — emails a reset link to the client app.
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email: String(email || '') } });
    if (user) {
      const token = await issueAuthToken(user.id, 'password_reset', 60 * 60 * 1000);
      await sendEmail(buildPasswordResetEmail(user.email, user.firstName || 'there', `${CLIENT_URL}/?resetToken=${token}`));
    }
    res.json({ message: 'If that email is registered, a password reset link has been sent.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Complete a password reset with the emailed token.
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const record = await prisma.authToken.findUnique({ where: { token: String(token) } });
    if (!record || record.purpose !== 'password_reset' || record.usedAt || record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { password: hashPassword(String(password)) } }),
      prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    const user = await prisma.user.findUnique({ where: { id: record.userId }, include: { profile: true } });
    if (user?.profile?.companyId) {
      await logAudit(user.profile.companyId, user.username, 'PASSWORD_RESET', 'User', user.id, user.username, 'Password reset completed via emailed link.');
    }
    res.json({ message: 'Your password has been reset. You can now sign in with your new password.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Dev-only: inspect captured emails when no real SMTP is configured.
app.get('/api/auth/dev-emails', (req, res) => {
  res.json(devEmailLog.slice(-10).reverse());
});

// ── COMPANY USER / TEAM MANAGEMENT ─────────────────────────────────────────
// NOTE: passwords are stored/compared in plain text to match the existing auth
// pattern (seed + register). Hashing is deferred as a separate cross-cutting change.

const VALID_ROLES = ['Admin', 'User'];

function shapeUser(u: any) {
  return {
    id: u.id, username: u.username, email: u.email,
    firstName: u.firstName, lastName: u.lastName, isActive: u.isActive,
    role: u.profile?.role || 'User',
    isSuperuser: u.isSuperuser,
  };
}

// List all users belonging to the current company
app.get('/api/company/users', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const users = await prisma.user.findMany({
      where: { profile: { companyId } },
      include: { profile: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map(shapeUser));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Add a team member to the current company (respects the plan's maxUsers cap)
app.post('/api/company/users', async (req, res) => {
  const companyId = getCompanyId(req);
  const { firstName, lastName, email, username, password, role } = req.body;
  if (!firstName || !lastName || !email || !username || !password) {
    return res.status(400).json({ error: 'First name, last name, email, username and password are required.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const newRole = VALID_ROLES.includes(role) ? role : 'User';
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId }, include: { plan: true } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });

    // Enforce plan seat limit
    const seatCount = await prisma.userProfile.count({ where: { companyId } });
    if (company.plan?.maxUsers != null && seatCount >= company.plan.maxUsers) {
      return res.status(403).json({ error: `Your ${company.plan.name} plan allows up to ${company.plan.maxUsers} users. Upgrade to add more team members.` });
    }

    const existing = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
    if (existing) return res.status(409).json({ error: 'A user with that username or email already exists.' });

    const user = await prisma.user.create({
      data: { username, email, password: hashPassword(password), firstName, lastName, isActive: true,
        profile: { create: { companyId, role: newRole } } },
      include: { profile: true },
    });

    await logAudit(companyId, 'admin', 'USER_ADDED', 'User', user.id, username,
      `Team member added: ${firstName} ${lastName} (${username}) as ${newRole}.`);

    res.status(201).json(shapeUser(user));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update a team member's role or active status (guards the last active admin)
app.patch('/api/company/users/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const userId = parseInt(req.params.id);
  const { role, isActive } = req.body;
  try {
    const target = await prisma.user.findFirst({ where: { id: userId, profile: { companyId } }, include: { profile: true } });
    if (!target) return res.status(404).json({ error: 'User not found in this company.' });

    const demoting = role !== undefined && role !== 'Admin' && target.profile?.role === 'Admin';
    const deactivating = isActive === false && target.isActive;
    if ((demoting || deactivating)) {
      // Ensure at least one other active Admin remains
      const otherActiveAdmins = await prisma.user.count({
        where: { id: { not: userId }, isActive: true, profile: { companyId, role: 'Admin' } },
      });
      if (otherActiveAdmins === 0) {
        return res.status(400).json({ error: 'This is the last active admin — assign another admin first.' });
      }
    }

    if (role !== undefined && VALID_ROLES.includes(role)) {
      await prisma.userProfile.update({ where: { userId }, data: { role } });
    }
    if (isActive !== undefined) {
      await prisma.user.update({ where: { id: userId }, data: { isActive: !!isActive } });
    }

    const updated = await prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });
    await logAudit(companyId, 'admin', 'USER_UPDATED', 'User', userId, target.username,
      `Team member updated${role !== undefined ? `, role → ${role}` : ''}${isActive !== undefined ? `, active → ${isActive}` : ''}.`);
    res.json(shapeUser(updated));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Remove a team member (cannot remove the last active admin)
app.delete('/api/company/users/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const userId = parseInt(req.params.id);
  try {
    const target = await prisma.user.findFirst({ where: { id: userId, profile: { companyId } }, include: { profile: true } });
    if (!target) return res.status(404).json({ error: 'User not found in this company.' });

    if (target.profile?.role === 'Admin') {
      const otherActiveAdmins = await prisma.user.count({
        where: { id: { not: userId }, isActive: true, profile: { companyId, role: 'Admin' } },
      });
      if (otherActiveAdmins === 0) {
        return res.status(400).json({ error: 'Cannot remove the last active admin.' });
      }
    }

    await prisma.user.delete({ where: { id: userId } }); // cascades to profile
    await logAudit(companyId, 'admin', 'USER_REMOVED', 'User', userId, target.username,
      `Team member removed: ${target.username}.`);
    res.json({ message: 'User removed.' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Fetch companies
app.get('/api/companies', async (req, res) => {
  try {
    const list = await prisma.company.findMany();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update business settings (fee policy, payment terms, currency). Admin-only in UI.
app.patch('/api/companies/:id/settings', async (req, res) => {
  const id = parseInt(req.params.id);
  const {
    currency, currencySymbol, defaultPaymentTermsDays,
    lateFeePercentPerDay, damageFeePercent, lostFeePercent, restockReturnedItems
  } = req.body;

  // Clamp percentages to a sane range so a typo can't create an absurd charge.
  const pct = (v: any, fallback: number) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (isNaN(n)) return undefined;
    return Math.min(1000, Math.max(0, n));
  };

  try {
    const data: any = {};
    if (currency !== undefined) data.currency = currency;
    if (currencySymbol !== undefined) data.currencySymbol = currencySymbol;
    if (defaultPaymentTermsDays !== undefined && !isNaN(Number(defaultPaymentTermsDays))) {
      data.defaultPaymentTermsDays = Math.max(0, parseInt(defaultPaymentTermsDays));
    }
    const lf = pct(lateFeePercentPerDay, 10); if (lf !== undefined) data.lateFeePercentPerDay = lf;
    const df = pct(damageFeePercent, 50); if (df !== undefined) data.damageFeePercent = df;
    const lo = pct(lostFeePercent, 100); if (lo !== undefined) data.lostFeePercent = lo;
    if (restockReturnedItems !== undefined) data.restockReturnedItems = !!restockReturnedItems;

    const company = await prisma.company.update({ where: { id }, data });

    await logAudit(id, 'admin', 'SETTINGS_UPDATED', 'Company', id, company.name,
      `Business settings updated. Late fee/day: ${company.lateFeePercentPerDay}%, Damage fee: ${company.damageFeePercent}%, Lost fee: ${company.lostFeePercent}%, Restock returns: ${company.restockReturnedItems}, Terms: Net ${company.defaultPaymentTermsDays}.`);

    res.json(company);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── CUSTOMERS ──────────────────────────────────────────────────────────

// 2b. Fetch all customers (with rental order count and watchlist status)
app.get('/api/customers', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.customer.findMany({
      where: { companyId },
      include: {
        _count: { select: { rentalOrders: true, bookings: true } }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2c. Create customer
app.post('/api/customers', async (req, res) => {
  const { companyId, name, contactInfo } = req.body;
  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId and name are required.' });
  }
  try {
    const customer = await prisma.customer.create({
      data: {
        companyId: parseInt(companyId),
        name,
        contactInfo: contactInfo || '',
        isOnWatchList: false
      }
    });
    res.status(201).json(customer);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2d. Toggle watchlist for a customer
app.patch('/api/customers/:id/watchlist', async (req, res) => {
  const { id } = req.params;
  const { isOnWatchList, watchListReason } = req.body;
  try {
    const updated = await prisma.customer.update({
      where: { id: parseInt(id) },
      data: { isOnWatchList, watchListReason: watchListReason || null }
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2e. Get full rental history for a customer
app.get('/api/customers/:id/history', async (req, res) => {
  const { id } = req.params;
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: parseInt(id) },
      include: {
        rentalOrders: { orderBy: { checkoutDate: 'desc' }, take: 20 },
        bookings: { orderBy: { bookingDate: 'desc' }, take: 10 }
      }
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── CUSTOMER ACCOUNTS & LEDGER ENDPOINTS ─────────────────────────────────

// Fetch all customer accounts with customer names & outstanding balances
app.get('/api/customer-accounts', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const customers = await prisma.customer.findMany({
      where: { companyId },
      include: { account: true }
    });

    // Make sure every customer has an account
    const list = [];
    for (const customer of customers) {
      const account = await getOrCreateCustomerAccount(customer.id, companyId);
      list.push({
        ...account,
        customerName: customer.name,
        isOnWatchList: customer.isOnWatchList
      });
    }

    // Sort by outstanding balance descending
    list.sort((a, b) => Number(b.totalOutstanding) - Number(a.totalOutstanding));
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch detailed account info, settings, and transaction log for a customer
app.get('/api/customer-accounts/:customerId', async (req, res) => {
  const companyId = getCompanyId(req);
  const customerId = parseInt(req.params.customerId);
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });
    if (!customer || customer.companyId !== companyId) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    const account = await getOrCreateCustomerAccount(customerId, companyId);

    const transactions = await prisma.customerAccountTransaction.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      account,
      customerName: customer.name,
      contactInfo: customer.contactInfo,
      transactions
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update settings (credit limit, payment terms, tax ID)
app.put('/api/customer-accounts/:customerId', async (req, res) => {
  const companyId = getCompanyId(req);
  const customerId = parseInt(req.params.customerId);
  const { creditLimit, paymentTermsDays, taxId } = req.body;
  try {
    const account = await getOrCreateCustomerAccount(customerId, companyId);

    const updated = await prisma.customerAccount.update({
      where: { id: account.id },
      data: {
        creditLimit: creditLimit !== undefined ? Number(creditLimit) : account.creditLimit,
        paymentTermsDays: paymentTermsDays !== undefined ? parseInt(paymentTermsDays) : account.paymentTermsDays,
        // taxId is a string, let's verify if taxId exists on schema. prisma.customerAccount has no taxId in schema?
        // Let's check schema: CustomerAccount only has creditLimit, paymentTermsDays, totalOutstanding, etc.
        // It has no taxId. We will skip taxId or keep it in Customer.contactInfo.
      }
    });

    await recalculateCustomerBalance(customerId, companyId);

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Post a manual transaction adjustment / refund
app.post('/api/customer-accounts/:customerId/transactions', async (req, res) => {
  const companyId = getCompanyId(req);
  const customerId = parseInt(req.params.customerId);
  const { transactionType, amount, description, referenceNumber, dueDate } = req.body;

  if (!transactionType || amount === undefined || !description) {
    return res.status(400).json({ error: 'transactionType, amount, and description are required.' });
  }

  try {
    const account = await getOrCreateCustomerAccount(customerId, companyId);

    const tx = await createAccountTransaction({
      customerId,
      companyId,
      transactionType,
      amount: Number(amount),
      description,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      referenceNumber: referenceNumber || `ADJ-${Math.floor(1000 + Math.random() * 9000)}`
    });

    if (Number(amount) < 0) {
      await recordIncome({
        companyId,
        incomeSource: transactionType === 'booking_deposit' ? 'booking_deposit' : 'invoice_payment',
        amount: Math.abs(Number(amount)),
        paymentMethod: 'cash',
        referenceNumber: tx.referenceNumber || undefined,
        description: `${description} (Customer Account Credit Adjustment)`
      });
    }

    res.status(201).json(tx);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Run a complete recalculation and backfill of all accounts from historical database records
app.post('/api/customer-accounts/recalculate', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const customers = await prisma.customer.findMany({
      where: { companyId }
    });

    let processedCount = 0;
    let transactionsCount = 0;

    for (const customer of customers) {
      const account = await getOrCreateCustomerAccount(customer.id, companyId);

      // Clear existing transactions to allow a fresh clean rebuild/backfill
      await prisma.customerAccountTransaction.deleteMany({
        where: { accountId: account.id }
      });

      // 1. Backfill from Rental Orders (debits & payments)
      const rentalOrders = await prisma.rentalOrder.findMany({
        where: { customerId: customer.id }
      });

      for (const order of rentalOrders) {
        const orderNum = order.companyOrderNumber;
        const checkoutDate = order.checkoutDate;

        // Debit: Base Rental Amount
        await prisma.customerAccountTransaction.create({
          data: {
            accountId: account.id,
            transactionType: 'invoice',
            amount: order.estimatedTotal,
            balanceAfterTransaction: 0,
            description: `Rental Order #${orderNum}`,
            referenceNumber: orderNum,
            createdAt: checkoutDate
          }
        });
        transactionsCount++;

        // Debit: Late Fee (if exists)
        if (Number(order.totalLateFeeCalculated) > 0) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'late_fee',
              amount: order.totalLateFeeCalculated,
              balanceAfterTransaction: 0,
              description: `Late return penalty on Order #${orderNum}`,
              referenceNumber: `${orderNum}-LF`,
              createdAt: order.actualReturnDate || checkoutDate
            }
          });
          transactionsCount++;
        }

        // Debit: Damage/Replacement Fee (if exists)
        if (Number(order.totalReplacementFeeCalculated) > 0) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'damage_fee',
              amount: order.totalReplacementFeeCalculated,
              balanceAfterTransaction: 0,
              description: `Damage/replacement charges on Order #${orderNum}`,
              referenceNumber: `${orderNum}-DF`,
              createdAt: order.actualReturnDate || checkoutDate
            }
          });
          transactionsCount++;
        }

        // Credit: Total Amount Paid (e.g. deposit or partial cash payment recorded on order)
        if (Number(order.totalAmountPaid) > 0) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'payment',
              amount: -Number(order.totalAmountPaid), // Credit
              balanceAfterTransaction: 0,
              description: `Payment/Deposit on Order #${orderNum}`,
              referenceNumber: `${orderNum}-PAY`,
              createdAt: checkoutDate
            }
          });
          transactionsCount++;
        }
      }

      // 2. Backfill from Booking deposits (only for bookings that were not converted to orders)
      const bookings = await prisma.booking.findMany({
        where: {
          customerId: customer.id,
          depositPaid: true,
          status: { not: 'converted' }
        }
      });

      for (const booking of bookings) {
        if (Number(booking.depositAmount) > 0) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'booking_deposit',
              amount: -Number(booking.depositAmount), // Credit
              balanceAfterTransaction: 0,
              description: `Booking Deposit - ${booking.bookingNumber}`,
              referenceNumber: booking.bookingNumber,
              createdAt: booking.depositPaidDate || booking.bookingDate
            }
          });
          transactionsCount++;
        }
      }

      // 3. Backfill from Paid Invoices (credit payments)
      const invoices = await prisma.invoice.findMany({
        where: {
          customerName: customer.name,
          status: 'Paid',
          paymentDate: { not: null }
        }
      });

      for (const invoice of invoices) {
        await prisma.customerAccountTransaction.create({
          data: {
            accountId: account.id,
            transactionType: 'payment',
            amount: -Number(invoice.amount), // Credit
            balanceAfterTransaction: 0,
            description: `Invoice Payment - ${invoice.referenceNumber} (${invoice.paymentMethod || 'Cash'})`,
            referenceNumber: invoice.referenceNumber,
            createdAt: invoice.paymentDate || invoice.createdAt
          }
        });
        transactionsCount++;
      }

      // 4. Backfill from Credit Notes (credit memo adjustment)
      const creditNotes = await prisma.creditNote.findMany({
        where: { customerName: customer.name }
      });

      for (const note of creditNotes) {
        await prisma.customerAccountTransaction.create({
          data: {
            accountId: account.id,
            transactionType: 'credit_memo',
            amount: -Number(note.amount), // Credit
            balanceAfterTransaction: 0,
            description: `Credit Memo - ${note.referenceNumber} (${note.reason})`,
            referenceNumber: note.referenceNumber,
            createdAt: note.createdAt
          }
        });
        transactionsCount++;
      }

      // Re-run the balance distribution & aging bucketing
      await recalculateCustomerBalance(customer.id, companyId);
      processedCount++;
    }

    res.json({
      message: 'Recalculation and backfill completed successfully.',
      processedCustomers: processedCount,
      recreatedTransactions: transactionsCount
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── ASSET MAINTENANCE, EVENTS RESERVATIONS, & OPERATIONS ──────────────────

// Fetch maintenance log for an asset
app.get('/api/serialized-assets/:assetId/maintenance', async (req, res) => {
  const companyId = getCompanyId(req);
  const assetId = parseInt(req.params.assetId);
  try {
    const list = await prisma.maintenanceEvent.findMany({
      where: { companyId, assetId },
      orderBy: { startTime: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Schedule a maintenance event
app.post('/api/serialized-assets/:assetId/maintenance', async (req, res) => {
  const companyId = getCompanyId(req);
  const assetId = parseInt(req.params.assetId);
  const { title, description, startTime, endTime, status, cost, notes } = req.body;

  if (!title || !startTime || !endTime) {
    return res.status(400).json({ error: 'title, startTime, and endTime are required.' });
  }

  try {
    const asset = await prisma.serializedAsset.findUnique({
      where: { id: assetId }
    });
    if (!asset || asset.companyId !== companyId) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    const event = await prisma.maintenanceEvent.create({
      data: {
        companyId,
        assetId,
        title,
        description: description || '',
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        status: status || 'Scheduled',
        cost: cost ? Number(cost) : 0.00,
        notes: notes || ''
      }
    });

    // If status is in_progress, mark asset as in Maintenance
    if (status === 'in_progress') {
      await prisma.serializedAsset.update({
        where: { id: assetId },
        data: { status: 'Maintenance' }
      });
    }

    res.status(201).json(event);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Complete a maintenance event
app.post('/api/maintenance-events/:id/complete', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { cost, notes } = req.body;
  try {
    const event = await prisma.maintenanceEvent.findUnique({
      where: { id }
    });
    if (!event || event.companyId !== companyId) {
      return res.status(404).json({ error: 'Maintenance event not found.' });
    }

    const updated = await prisma.maintenanceEvent.update({
      where: { id },
      data: {
        status: 'Completed',
        cost: cost !== undefined ? Number(cost) : event.cost,
        notes: notes !== undefined ? notes : event.notes
      }
    });

    // Update asset status back to Available
    await prisma.serializedAsset.update({
      where: { id: event.assetId },
      data: { status: 'Available' }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch items/assets reserved for an event
app.get('/api/functions/:functionId/items', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionItemAssignment.findMany({
      where: { companyId, functionId },
      include: {
        item: true,
        asset: true,
        consumable: {
          include: {
            packageUnit: true,
            pieceUnit: true,
            unitOfMeasure: true
          }
        },
        unitOfMeasure: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Reserve item or asset for an event
app.post('/api/functions/:functionId/items', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { itemType, itemId, assetId, consumableId, unitOfMeasureId, quantity, notes } = req.body;

  if (!itemType || (itemType === 'item' && !itemId) || (itemType === 'asset' && !assetId) || (itemType === 'consumable' && !consumableId)) {
    return res.status(400).json({ error: 'itemType, and itemId/assetId/consumableId are required.' });
  }

  try {
    const func = await prisma.functionEvent.findUnique({
      where: { id: functionId }
    });
    if (!func || func.companyId !== companyId) {
      return res.status(404).json({ error: 'Function not found.' });
    }

    if (itemType === 'asset') {
      const asset = await prisma.serializedAsset.findUnique({
        where: { id: parseInt(assetId) }
      });
      if (!asset || asset.companyId !== companyId) {
        return res.status(404).json({ error: 'Asset not found.' });
      }
      if (asset.status !== 'Available') {
        return res.status(400).json({ error: `Asset is currently ${asset.status} and cannot be reserved.` });
      }

      // Check if already reserved for this function
      const exists = await prisma.functionItemAssignment.findFirst({
        where: { functionId, assetId: asset.id, status: { not: 'cancelled' } }
      });
      if (exists) {
        return res.status(400).json({ error: 'Asset is already reserved for this event.' });
      }
    } else if (itemType === 'consumable') {
      const consumable = await prisma.consumable.findUnique({
        where: { id: parseInt(consumableId) }
      });
      if (!consumable || consumable.companyId !== companyId) {
        return res.status(404).json({ error: 'Consumable not found.' });
      }
    } else {
      const item = await prisma.item.findUnique({
        where: { id: parseInt(itemId) }
      });
      if (!item || item.companyId !== companyId) {
        return res.status(404).json({ error: 'Item not found.' });
      }
    }

    const assignment = await prisma.functionItemAssignment.create({
      data: {
        companyId,
        functionId,
        itemType,
        itemId: itemId ? parseInt(itemId) : null,
        assetId: assetId ? parseInt(assetId) : null,
        consumableId: consumableId ? parseInt(consumableId) : null,
        unitOfMeasureId: unitOfMeasureId ? parseInt(unitOfMeasureId) : null,
        quantity: itemType === 'asset' ? 1 : parseInt(quantity) || 1,
        notes: notes || '',
        status: 'booked'
      },
      include: {
        item: true,
        asset: true,
        consumable: {
          include: {
            packageUnit: true,
            pieceUnit: true,
            unitOfMeasure: true
          }
        },
        unitOfMeasure: true
      }
    });

    const name = assignment.item?.name || assignment.asset?.name || assignment.consumable?.name || '';
    const uomAbbrev = assignment.unitOfMeasure?.abbreviation || '';
    const qtyLabel = uomAbbrev ? `${assignment.quantity} ${uomAbbrev}` : `${assignment.quantity}`;
    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId,
        activityType: 'note_added',
        description: `Reserved ${itemType === 'asset' ? 'asset' : itemType === 'consumable' ? 'consumable' : 'item'}: ${name} (Qty: ${qtyLabel})`
      }
    });

    res.status(201).json(assignment);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Cancel reservation
app.delete('/api/function-items/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const assignment = await prisma.functionItemAssignment.findUnique({
      where: { id },
      include: { item: true, asset: true }
    });
    if (!assignment || assignment.companyId !== companyId) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    // If dispatched, restore stock/status first
    if (assignment.status === 'dispatched') {
      if (assignment.itemType === 'asset' && assignment.assetId) {
        await prisma.serializedAsset.update({
          where: { id: assignment.assetId },
          data: { status: 'Available' }
        });
      } else if (assignment.itemType === 'item' && assignment.itemId) {
        await prisma.item.update({
          where: { id: assignment.itemId },
          data: { currentStock: { increment: assignment.quantity } }
        });
      }
    }

    await prisma.functionItemAssignment.delete({
      where: { id }
    });

    const name = assignment.item?.name || assignment.asset?.name || '';
    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId: assignment.functionId,
        activityType: 'note_added',
        description: `Cancelled reservation for ${name}`
      }
    });

    res.json({ message: 'Reservation cancelled successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Dispatch reservation (marks dispatched, updates stock/asset status)
app.post('/api/function-items/:id/dispatch', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const assignment = await prisma.functionItemAssignment.findUnique({
      where: { id },
      include: { item: true, asset: true }
    });
    if (!assignment || assignment.companyId !== companyId) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (assignment.status !== 'booked') {
      return res.status(400).json({ error: `Cannot dispatch item with status ${assignment.status}` });
    }

    const updated = await prisma.functionItemAssignment.update({
      where: { id },
      data: {
        status: 'dispatched',
        dispatchedAt: new Date()
      }
    });

    if (assignment.itemType === 'asset' && assignment.assetId) {
      await prisma.serializedAsset.update({
        where: { id: assignment.assetId },
        data: { status: 'Rented' }
      });
    } else if (assignment.itemType === 'item' && assignment.itemId) {
      await prisma.item.update({
        where: { id: assignment.itemId },
        data: { currentStock: { decrement: assignment.quantity } }
      });
    } else if (assignment.itemType === 'consumable' && assignment.consumableId) {
      const consumable = await prisma.consumable.findUnique({
        where: { id: assignment.consumableId }
      });
      if (!consumable) throw new Error('Consumable not found.');
      
      const baseQty = (consumable.isMultiUnit && assignment.unitOfMeasureId && assignment.unitOfMeasureId === consumable.packageUnitId)
        ? assignment.quantity * consumable.unitRatio
        : assignment.quantity;

      if (consumable.stockQty < baseQty) {
        throw new Error(`Insufficient stock. Available: ${consumable.stockQty}, Required: ${baseQty}`);
      }

      await prisma.consumable.update({
        where: { id: assignment.consumableId },
        data: { stockQty: { decrement: baseQty } }
      });

      await prisma.consumableLog.create({
        data: {
          consumableId: assignment.consumableId,
          action: 'use',
          quantity: baseQty,
          operator: 'system',
          notes: `Used in event Ceremony load-out (Assignment #${assignment.id})`
        }
      });

      // Record Expense
      const totalCost = Number(consumable.costPrice) * baseQty;
      if (totalCost > 0) {
        await prisma.expense.create({
          data: {
            companyId,
            amount: totalCost,
            expenseCategory: 'Event Setup Expenses',
            expenseDate: new Date().toISOString().split('T')[0],
            paymentMethod: 'internal',
            notes: `Event Setup Cost: ${assignment.quantity} x ${consumable.name} (Ceremony: Function #${assignment.functionId})`
          }
        });
      }
    }

    const name = assignment.item?.name || assignment.asset?.name || '';
    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId: assignment.functionId,
        activityType: 'item_dispatched',
        description: `Dispatched ${name} (Qty: ${assignment.quantity})`
      }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Return reservation (marks returned, restores stock/asset status)
app.post('/api/function-items/:id/return', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const assignment = await prisma.functionItemAssignment.findUnique({
      where: { id },
      include: { item: true, asset: true }
    });
    if (!assignment || assignment.companyId !== companyId) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (assignment.status !== 'dispatched') {
      return res.status(400).json({ error: `Cannot return item with status ${assignment.status}` });
    }

    const updated = await prisma.functionItemAssignment.update({
      where: { id },
      data: {
        status: 'returned',
        returnedAt: new Date()
      }
    });

    if (assignment.itemType === 'asset' && assignment.assetId) {
      await prisma.serializedAsset.update({
        where: { id: assignment.assetId },
        data: { status: 'Available' }
      });
    } else if (assignment.itemType === 'item' && assignment.itemId) {
      await prisma.item.update({
        where: { id: assignment.itemId },
        data: { currentStock: { increment: assignment.quantity } }
      });
    } else if (assignment.itemType === 'consumable' && assignment.consumableId) {
      const consumable = await prisma.consumable.findUnique({
        where: { id: assignment.consumableId }
      });
      if (!consumable) throw new Error('Consumable not found.');
      
      const baseQty = (consumable.isMultiUnit && assignment.unitOfMeasureId && assignment.unitOfMeasureId === consumable.packageUnitId)
        ? assignment.quantity * consumable.unitRatio
        : assignment.quantity;

      await prisma.consumable.update({
        where: { id: assignment.consumableId },
        data: { stockQty: { increment: baseQty } }
      });

      await prisma.consumableLog.create({
        data: {
          consumableId: assignment.consumableId,
          action: 'restock',
          quantity: baseQty,
          operator: 'system',
          notes: `Returned unused from event Ceremony (Assignment #${assignment.id})`
        }
      });

      // Record a Reversal Expense (Negative Expense to offset the COGS)
      const totalCost = Number(consumable.costPrice) * baseQty;
      if (totalCost > 0) {
        await prisma.expense.create({
          data: {
            companyId,
            amount: -totalCost,
            expenseCategory: 'Event Setup Expenses',
            expenseDate: new Date().toISOString().split('T')[0],
            paymentMethod: 'internal',
            notes: `Event Cost Reversal: Returned unused ${assignment.quantity} x ${consumable.name}`
          }
        });
      }
    }

    const name = assignment.item?.name || assignment.asset?.name || '';
    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId: assignment.functionId,
        activityType: 'item_returned',
        description: `Returned ${name} (Qty: ${assignment.quantity})`
      }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch checklist items for an event
app.get('/api/functions/:functionId/checklist', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionChecklistItem.findMany({
      where: { companyId, functionId },
      include: { assignedEmployee: true },
      orderBy: { id: 'asc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Add checklist item
app.post('/api/functions/:functionId/checklist', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { itemText, notes, assignedEmployeeId } = req.body;

  if (!itemText) {
    return res.status(400).json({ error: 'itemText is required.' });
  }

  try {
    const item = await prisma.functionChecklistItem.create({
      data: {
        companyId,
        functionId,
        itemText,
        notes: notes || '',
        isCompleted: false,
        assignedEmployeeId: assignedEmployeeId ? parseInt(assignedEmployeeId) : null
      },
      include: { assignedEmployee: true }
    });
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle checklist completion status
app.put('/api/checklist-items/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { isCompleted } = req.body;
  try {
    const item = await prisma.functionChecklistItem.findUnique({
      where: { id }
    });
    if (!item || item.companyId !== companyId) {
      return res.status(404).json({ error: 'Checklist item not found.' });
    }

    const updated = await prisma.functionChecklistItem.update({
      where: { id },
      data: {
        isCompleted: Boolean(isCompleted),
        completedAt: isCompleted ? new Date() : null
      },
      include: { assignedEmployee: true }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch reported issues for an event
app.get('/api/functions/:functionId/issues', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionIssue.findMany({
      where: { companyId, functionId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Log event issue
app.post('/api/functions/:functionId/issues', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { title, description, severity } = req.body;

  if (!title || !description) {
    return res.status(400).json({ error: 'title and description are required.' });
  }

  try {
    const issue = await prisma.functionIssue.create({
      data: {
        companyId,
        functionId,
        title,
        description,
        severity: severity || 'Medium',
        status: 'Reported'
      }
    });

    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId,
        activityType: 'issue_reported',
        description: `⚠️ [${issue.severity}] Issue reported: "${issue.title}"`
      }
    });

    res.status(201).json(issue);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update issue (status/resolution notes)
app.put('/api/issues/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { status, resolutionNotes } = req.body;
  try {
    const issue = await prisma.functionIssue.findUnique({
      where: { id }
    });
    if (!issue || issue.companyId !== companyId) {
      return res.status(404).json({ error: 'Issue not found.' });
    }

    const updated = await prisma.functionIssue.update({
      where: { id },
      data: {
        status: status || issue.status,
        resolutionNotes: resolutionNotes !== undefined ? resolutionNotes : issue.resolutionNotes
      }
    });

    if (status === 'Resolved') {
      await prisma.functionActivity.create({
        data: {
          companyId,
          functionId: issue.functionId,
          activityType: 'issue_resolved',
          description: `✅ Issue resolved: "${issue.title}"`
        }
      });
    }

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch activity timeline for an event
app.get('/api/functions/:functionId/activities', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionActivity.findMany({
      where: { companyId, functionId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Post a manual timeline note
app.post('/api/functions/:functionId/activities', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { description } = req.body;

  if (!description) {
    return res.status(400).json({ error: 'description is required.' });
  }

  try {
    const note = await prisma.functionActivity.create({
      data: {
        companyId,
        functionId,
        activityType: 'note_added',
        description
      }
    });
    res.status(201).json(note);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION EXPENSES ────────────────────────────────────────────────────
app.get('/api/functions/:functionId/expenses', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionExpense.findMany({
      where: { companyId, functionId },
      orderBy: { id: 'desc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/functions/:functionId/expenses', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { expenseType, description, amount, expenseDate, receiptNumber, notes } = req.body;
  if (!description || amount === undefined || !expenseDate) {
    return res.status(400).json({ error: 'description, amount, and expenseDate are required.' });
  }
  try {
    const expense = await prisma.functionExpense.create({
      data: {
        companyId, functionId,
        expenseType: expenseType || 'other',
        description, amount: Number(amount), expenseDate,
        receiptNumber: receiptNumber || null, notes: notes || null,
      }
    });

    // Recompute the function's total_expenses aggregate (mirrors the original's approach).
    const agg = await prisma.functionExpense.aggregate({ where: { functionId }, _sum: { amount: true } });
    await prisma.functionEvent.update({ where: { id: functionId }, data: { totalExpenses: agg._sum.amount || 0 } });

    await prisma.functionActivity.create({
      data: { companyId, functionId, activityType: 'expense_recorded', description: `Expense recorded: ${description} (${Number(amount).toLocaleString()})` }
    });

    res.status(201).json(expense);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/function-expenses/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const expense = await prisma.functionExpense.findFirst({ where: { id, companyId } });
    if (!expense) return res.status(404).json({ error: 'Expense not found.' });

    await prisma.functionExpense.delete({ where: { id } });
    const agg = await prisma.functionExpense.aggregate({ where: { functionId: expense.functionId }, _sum: { amount: true } });
    await prisma.functionEvent.update({ where: { id: expense.functionId }, data: { totalExpenses: agg._sum.amount || 0 } });

    await prisma.functionActivity.create({
      data: { companyId, functionId: expense.functionId, activityType: 'other', description: `Expense removed: ${expense.description}` }
    });

    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION REVENUE ─────────────────────────────────────────────────────
// Recording revenue also posts to the consolidated Income ledger (source: function_fee),
// matching the original system's behavior of keeping per-function P&L and company-wide
// revenue reporting in sync.
app.post('/api/functions/:functionId/revenue', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { amount, paymentMethod, paymentDate, referenceNumber, notes } = req.body;
  if (amount === undefined || Number(amount) <= 0) {
    return res.status(400).json({ error: 'A positive amount is required.' });
  }
  try {
    const func = await prisma.functionEvent.findFirst({ where: { id: functionId, companyId } });
    if (!func) return res.status(404).json({ error: 'Function not found.' });

    const now = new Date();
    const updated = await prisma.functionEvent.update({
      where: { id: functionId },
      data: {
        totalRevenue: { increment: Number(amount) },
        revenuePaid: true,
        revenuePaidDate: func.revenuePaidDate || now,
      }
    });

    await recordIncome({
      companyId, incomeSource: 'function_fee', amount: Number(amount),
      paymentMethod: paymentMethod || 'cash', referenceNumber: referenceNumber || undefined,
      description: `Function revenue — ${func.name}${notes ? `: ${notes}` : ''}`,
      otherFeeAmount: Number(amount),
    });

    await prisma.functionActivity.create({
      data: { companyId, functionId, activityType: 'revenue_recorded', description: `Revenue recorded: ${Number(amount).toLocaleString()} via ${paymentMethod || 'cash'}${referenceNumber ? ` (ref ${referenceNumber})` : ''}` }
    });

    res.status(201).json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION COMPLETION ──────────────────────────────────────────────────
app.post('/api/functions/:functionId/complete', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { completionNotes } = req.body;
  try {
    const func = await prisma.functionEvent.findFirst({ where: { id: functionId, companyId } });
    if (!func) return res.status(404).json({ error: 'Function not found.' });

    const updated = await prisma.functionEvent.update({
      where: { id: functionId },
      data: {
        status: 'Completed',
        completionNotes: completionNotes || null,
        completedAt: func.completedAt || new Date(),
      }
    });

    await prisma.functionActivity.create({
      data: { companyId, functionId, activityType: 'status_changed', description: `Function marked Completed.${completionNotes ? ` Notes: ${completionNotes}` : ''}` }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION SIGNATURES ──────────────────────────────────────────────────
app.get('/api/functions/:functionId/signatures', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionSignature.findMany({
      where: { companyId, functionId },
      orderBy: { id: 'desc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/functions/:functionId/signatures', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { signatureType, signeeName, signeeContact, signatureData, confirmationNotes } = req.body;
  if (!signatureType || !signeeName || !signatureData) {
    return res.status(400).json({ error: 'signatureType, signeeName, and signatureData are required.' });
  }
  try {
    const sig = await prisma.functionSignature.create({
      data: { companyId, functionId, signatureType, signeeName, signeeContact: signeeContact || null, signatureData, confirmationNotes: confirmationNotes || null }
    });

    await prisma.functionActivity.create({
      data: { companyId, functionId, activityType: 'other', description: `Signature captured (${signatureType}) from ${signeeName}.` }
    });

    res.status(201).json(sig);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION TEMPLATES ───────────────────────────────────────────────────
app.get('/api/function-templates', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.functionTemplate.findMany({
      where: { companyId, isActive: true },
      include: { items: { include: { item: true, asset: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/function-templates', async (req, res) => {
  const companyId = getCompanyId(req);
  const { name, description, defaultLocation, defaultTime, defaultNotes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });
  try {
    const existing = await prisma.functionTemplate.findFirst({ where: { companyId, name } });
    if (existing) return res.status(409).json({ error: 'A template with that name already exists.' });

    const template = await prisma.functionTemplate.create({
      data: { companyId, name, description: description || null, defaultLocation: defaultLocation || null, defaultTime: defaultTime || null, defaultNotes: defaultNotes || null }
    });
    res.status(201).json(template);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/function-templates/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    await prisma.functionTemplate.deleteMany({ where: { id: parseInt(req.params.id), companyId } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/function-templates/:id/items', async (req, res) => {
  const companyId = getCompanyId(req);
  const templateId = parseInt(req.params.id);
  const { itemType, itemId, assetId, quantity, notes } = req.body;
  if (!itemType || (itemType === 'item' && !itemId) || (itemType === 'asset' && !assetId)) {
    return res.status(400).json({ error: 'itemType and a matching itemId/assetId are required.' });
  }
  try {
    const template = await prisma.functionTemplate.findFirst({ where: { id: templateId, companyId } });
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    const item = await prisma.functionTemplateItem.create({
      data: {
        templateId, itemType,
        itemId: itemType === 'item' ? parseInt(itemId) : null,
        assetId: itemType === 'asset' ? parseInt(assetId) : null,
        quantity: parseInt(quantity) || 1, notes: notes || null,
      }
    });
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/function-template-items/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const item = await prisma.functionTemplateItem.findFirst({ where: { id }, include: { template: true } });
    if (!item || item.template.companyId !== companyId) return res.status(404).json({ error: 'Template item not found.' });
    await prisma.functionTemplateItem.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Create a new function from a template: copies name/location/time/notes defaults
// (overridable) and pre-books the template's items as FunctionItemAssignment rows.
app.post('/api/function-templates/:id/create-function', async (req, res) => {
  const companyId = getCompanyId(req);
  const templateId = parseInt(req.params.id);
  const { name, date, time, location, clientName, clientContact, notes } = req.body;
  if (!name || !date || !clientName) {
    return res.status(400).json({ error: 'name, date, and clientName are required.' });
  }
  try {
    const template = await prisma.functionTemplate.findFirst({ where: { id: templateId, companyId }, include: { items: true } });
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    const func = await prisma.functionEvent.create({
      data: {
        companyId, name, date,
        time: time || template.defaultTime || '',
        location: location || template.defaultLocation || '',
        clientName, clientContact: clientContact || '',
        notes: notes || template.defaultNotes || null,
        templateName: template.name,
        functionItemAssignments: {
          create: template.items.map(ti => ({
            companyId,
            itemType: ti.itemType,
            itemId: ti.itemId,
            assetId: ti.assetId,
            quantity: ti.quantity,
            notes: ti.notes,
            status: 'booked',
          }))
        }
      },
      include: { functionItemAssignments: true }
    });

    await prisma.functionActivity.create({
      data: { companyId, functionId: func.id, activityType: 'other', description: `Function created from template "${template.name}" with ${template.items.length} pre-booked item(s).` }
    });

    res.status(201).json(func);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2-Day Availability Checker Dashboard Alerts API
app.get('/api/dashboard/function-alerts', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const today = new Date();
    // Format date string as YYYY-MM-DD
    const targetDateObj = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
    const targetDateStr = targetDateObj.toISOString().split('T')[0];

    const upcomingFunctions = await prisma.functionEvent.findMany({
      where: {
        companyId,
        status: { not: 'Cancelled' },
        date: targetDateStr
      },
      include: {
        functionItemAssignments: {
          where: { status: 'booked' },
          include: { item: true, asset: true }
        }
      }
    });

    const alerts = [];

    for (const func of upcomingFunctions) {
      for (const assign of func.functionItemAssignments) {
        if (assign.itemType === 'asset' && assign.asset) {
          // If asset is currently Rented or in Maintenance
          if (assign.asset.status !== 'Available') {
            alerts.push({
              id: assign.id,
              functionId: func.id,
              functionName: func.name,
              functionDate: func.date,
              type: 'asset',
              name: assign.asset.name,
              serialNumber: assign.asset.serialNumber,
              message: `Asset "${assign.asset.name}" (${assign.asset.serialNumber}) is reserved for "${func.name}" but its status is currently "${assign.asset.status}".`
            });
          }
        } else if (assign.itemType === 'item' && assign.item) {
          // If inventory stock is below the reserved quantity
          if (assign.item.currentStock < assign.quantity) {
            alerts.push({
              id: assign.id,
              functionId: func.id,
              functionName: func.name,
              functionDate: func.date,
              type: 'stock',
              name: assign.item.name,
              message: `Item "${assign.item.name}" has ${assign.item.currentStock} units in stock, but ${assign.quantity} units are reserved for "${func.name}".`
            });
          }
        }
      }
    }

    res.json(alerts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GLOBAL UNITS OF MEASURE ENDPOINTS ────────────────────────────────────────

app.get('/api/uoms', async (req, res) => {
  try {
    const list = await prisma.unitOfMeasure.findMany({
      where: { isActive: true },
      orderBy: [
        { category: 'asc' },
        { name: 'asc' }
      ]
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONSUMABLE STOCK ENDPOINTS ─────────────────────────────────────────────

app.get('/api/consumables', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.consumable.findMany({
      where: { companyId },
      include: {
        packageUnit: { select: { id: true, name: true, abbreviation: true, code: true } },
        pieceUnit: { select: { id: true, name: true, abbreviation: true, code: true } },
        unitOfMeasure: { select: { id: true, name: true, abbreviation: true, code: true } }
      },
      orderBy: { name: 'asc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/consumables', async (req, res) => {
  const companyId = getCompanyId(req);
  const { 
    name, 
    category, 
    stockQty, 
    restockLevel, 
    unitPrice, 
    costPrice, 
    sku,
    isMultiUnit,
    packageUnitId,
    pieceUnitId,
    unitRatio,
    packagePrice,
    unitOfMeasureId
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required.' });
  }

  try {
    const record = await prisma.consumable.create({
      data: {
        companyId,
        name,
        category: category || 'general',
        stockQty: stockQty !== undefined ? parseInt(stockQty) : 0,
        restockLevel: restockLevel !== undefined ? parseInt(restockLevel) : 0,
        unitPrice: unitPrice !== undefined ? Number(unitPrice) : 0,
        costPrice: costPrice !== undefined ? Number(costPrice) : 0,
        sku: sku || null,
        isMultiUnit: !!isMultiUnit,
        packageUnitId: packageUnitId ? parseInt(packageUnitId) : null,
        pieceUnitId: pieceUnitId ? parseInt(pieceUnitId) : null,
        unitRatio: unitRatio !== undefined ? parseInt(unitRatio) : 1,
        packagePrice: packagePrice !== undefined && packagePrice !== null ? Number(packagePrice) : null,
        unitOfMeasureId: unitOfMeasureId ? parseInt(unitOfMeasureId) : null,
      }
    });

    // Write initial log if stock is positive
    if (record.stockQty > 0) {
      await prisma.consumableLog.create({
        data: {
          consumableId: record.id,
          action: 'adjustment',
          quantity: record.stockQty,
          operator: 'system',
          notes: 'Initial stock register audit inflow.'
        }
      });
    }

    res.status(201).json(record);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/consumables/:id/use', async (req, res) => {
  const consumableId = parseInt(req.params.id);
  const { quantity, notes, operator } = req.body;

  if (quantity === undefined || parseInt(quantity) <= 0) {
    return res.status(400).json({ error: 'quantity must be positive.' });
  }

  try {
    const consumable = await prisma.consumable.findUnique({
      where: { id: consumableId }
    });

    if (!consumable) {
      return res.status(404).json({ error: 'Consumable not found.' });
    }

    const qty = parseInt(quantity);
    if (consumable.stockQty < qty) {
      return res.status(400).json({ error: `Insufficient stock in register. Current stock: ${consumable.stockQty}` });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedItem = await tx.consumable.update({
        where: { id: consumableId },
        data: { stockQty: { decrement: qty } }
      });

      await tx.consumableLog.create({
        data: {
          consumableId,
          action: 'use',
          quantity: qty,
          operator: operator || 'staff',
          notes: notes || 'Stock consumption.'
        }
      });

      return updatedItem;
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/consumables/:id/restock', async (req, res) => {
  const consumableId = parseInt(req.params.id);
  const { quantity, costPrice, notes, operator } = req.body;

  if (quantity === undefined || parseInt(quantity) <= 0) {
    return res.status(400).json({ error: 'quantity must be positive.' });
  }

  try {
    const consumable = await prisma.consumable.findUnique({
      where: { id: consumableId }
    });

    if (!consumable) {
      return res.status(404).json({ error: 'Consumable not found.' });
    }

    const qty = parseInt(quantity);

    const updated = await prisma.$transaction(async (tx) => {
      const dataUpdate: any = { stockQty: { increment: qty } };
      if (costPrice !== undefined) {
        dataUpdate.costPrice = Number(costPrice);
      }

      const updatedItem = await tx.consumable.update({
        where: { id: consumableId },
        data: dataUpdate
      });

      await tx.consumableLog.create({
        data: {
          consumableId,
          action: 'restock',
          quantity: qty,
          operator: operator || 'staff',
          notes: notes || 'Restock replenishment.'
        }
      });

      return updatedItem;
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/consumables/:id/logs', async (req, res) => {
  const consumableId = parseInt(req.params.id);
  try {
    const list = await prisma.consumableLog.findMany({
      where: { consumableId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONSOLIDATED REVENUE LEDGER ENDPOINTS ──────────────────────────────────

// Fetch all income records with filters and search
// Helper to build dynamic query filters for consolidated revenue ledger
async function buildIncomeWhereClause(companyId: number, query: any) {
  const { incomeSource, paymentMethod, startDate, endDate, search, category, customerName } = query;
  const whereClause: any = { companyId };

  if (incomeSource) {
    whereClause.incomeSource = String(incomeSource);
  }
  if (paymentMethod) {
    whereClause.paymentMethod = String(paymentMethod);
  }

  if (startDate || endDate) {
    whereClause.paymentDate = {};
    if (startDate) {
      whereClause.paymentDate.gte = new Date(String(startDate));
    }
    if (endDate) {
      const end = new Date(String(endDate));
      end.setHours(23, 59, 59, 999);
      whereClause.paymentDate.lte = end;
    }
  }

  if (search) {
    whereClause.OR = [
      { description: { contains: String(search) } },
      { referenceNumber: { contains: String(search) } }
    ];
  }

  if (customerName) {
    const cust = String(customerName);
    whereClause.description = { contains: cust };
  }

  if (category) {
    const cat = String(category);
    
    // Find matching bookings
    const matchingBookings = await prisma.booking.findMany({
      where: {
        companyId,
        lineItems: {
          some: {
            OR: [
              { item: { category: { equals: cat } } },
              { asset: { assetType: { equals: cat } } },
              { consumable: { category: { equals: cat } } }
            ]
          }
        }
      },
      select: { bookingNumber: true }
    });
    const bookingNums = matchingBookings.map(b => b.bookingNumber);

    // Find matching rental orders
    const matchingOrders = await prisma.rentalOrder.findMany({
      where: {
        companyId,
        lineItems: {
          some: {
            OR: [
              { item: { category: { equals: cat } } },
              { asset: { assetType: { equals: cat } } },
              { consumable: { category: { equals: cat } } }
            ]
          }
        }
      },
      select: { companyOrderNumber: true }
    });
    const orderNums = matchingOrders.map(o => o.companyOrderNumber);

    const refCodes = [...bookingNums, ...orderNums];
    
    if (whereClause.OR) {
      whereClause.AND = [
        { OR: whereClause.OR },
        {
          OR: [
            { referenceNumber: { in: refCodes } },
            { description: { contains: cat } }
          ]
        }
      ];
      delete whereClause.OR;
    } else {
      whereClause.OR = [
        { referenceNumber: { in: refCodes } },
        { description: { contains: cat } }
      ];
    }
  }

  return whereClause;
}

app.get('/api/income', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const whereClause = await buildIncomeWhereClause(companyId, req.query);
    const list = await prisma.income.findMany({
      where: whereClause,
      orderBy: { paymentDate: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Export the filtered revenue ledger to CSV (honours the same query filters as /api/income)
app.get('/api/export/income', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const whereClause = await buildIncomeWhereClause(companyId, req.query);
    const list = await prisma.income.findMany({ where: whereClause, orderBy: { paymentDate: 'desc' } });
    let csv = 'paymentDate,incomeSource,amount,paymentMethod,referenceNumber,description,baseRentalAmount,lateFeeAmount,damageFeeAmount,depositAmount\n';
    list.forEach(r => {
      const date = new Date(r.paymentDate).toISOString().split('T')[0];
      csv += `${date},${csvCell(r.incomeSource)},${r.amount},${csvCell(r.paymentMethod)},${csvCell(r.referenceNumber)},${csvCell(r.description)},${r.baseRentalAmount},${r.lateFeeAmount},${r.damageFeeAmount},${r.depositAmount}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=revenue-report.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Record manual miscellaneous income
app.post('/api/income', async (req, res) => {
  const companyId = getCompanyId(req);
  const { amount, paymentMethod, paymentDate, referenceNumber, description, baseRentalAmount, lateFeeAmount, damageFeeAmount, depositAmount, otherFeeAmount } = req.body;

  if (amount === undefined || !paymentMethod || !description) {
    return res.status(400).json({ error: 'amount, paymentMethod, and description are required.' });
  }

  try {
    const record = await recordIncome({
      companyId,
      incomeSource: 'manual',
      amount: Number(amount),
      paymentMethod,
      referenceNumber: referenceNumber || undefined,
      description,
      baseRentalAmount: baseRentalAmount ? Number(baseRentalAmount) : 0,
      lateFeeAmount: lateFeeAmount ? Number(lateFeeAmount) : 0,
      damageFeeAmount: damageFeeAmount ? Number(damageFeeAmount) : 0,
      depositAmount: depositAmount ? Number(depositAmount) : 0,
      otherFeeAmount: otherFeeAmount ? Number(otherFeeAmount) : Number(amount) // default other fee to amount for manual entries
    });

    res.status(201).json(record);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch income analytical metrics and summaries
app.get('/api/income/analytics', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const whereClause = await buildIncomeWhereClause(companyId, req.query);
    const allRecords = await prisma.income.findMany({
      where: whereClause
    });

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    let todayTotal = 0;
    let monthTotal = 0;
    let yearTotal = 0;
    let allTimeTotal = 0;

    const sourceTotals: Record<string, number> = {
      rental_order: 0,
      booking_deposit: 0,
      late_fee: 0,
      damage_fee: 0,
      invoice_payment: 0,
      manual: 0
    };

    const methodTotals: Record<string, number> = {
      cash: 0,
      check: 0,
      credit_card: 0,
      bank_transfer: 0,
      stripe: 0,
      mobile_money: 0,
      other: 0
    };

    for (const rec of allRecords) {
      const amt = Number(rec.amount);
      const pDate = new Date(rec.paymentDate);
      const pDateStr = pDate.toISOString().split('T')[0];

      allTimeTotal += amt;

      // Group totals
      if (pDateStr === todayStr) {
        todayTotal += amt;
      }
      if (pDate.getMonth() === currentMonth && pDate.getFullYear() === currentYear) {
        monthTotal += amt;
      }
      if (pDate.getFullYear() === currentYear) {
        yearTotal += amt;
      }

      // Source breakdown
      const src = rec.incomeSource;
      if (sourceTotals[src] !== undefined) {
        sourceTotals[src] += amt;
      } else {
        sourceTotals[src] = amt;
      }

      // Method breakdown
      const method = rec.paymentMethod;
      if (methodTotals[method] !== undefined) {
        methodTotals[method] += amt;
      } else {
        methodTotals[method] = amt;
      }
    }

    res.json({
      todayTotal,
      monthTotal,
      yearTotal,
      allTimeTotal,
      bySource: sourceTotals,
      byMethod: methodTotals
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── HELP & SUPPORT KNOWLEDGE DATABASE ENDPOINTS ────────────────────────────

// Fetch categories with article counts
app.get('/api/help/categories', async (req, res) => {
  try {
    const categories = await prisma.helpCategory.findMany({
      include: {
        _count: {
          select: { articles: true }
        }
      },
      orderBy: { name: 'asc' }
    });
    res.json(categories);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch articles with filters
app.get('/api/help/articles', async (req, res) => {
  const { categoryId, search } = req.query;
  try {
    const where: any = {};
    if (categoryId) {
      where.categoryId = parseInt(String(categoryId));
    }
    if (search) {
      where.OR = [
        { title: { contains: String(search) } },
        { content: { contains: String(search) } }
      ];
    }
    const articles = await prisma.helpArticle.findMany({
      where,
      select: {
        id: true,
        categoryId: true,
        title: true,
        slug: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: { title: 'asc' }
    });
    res.json(articles);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch detailed guide content
app.get('/api/help/articles/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const article = await prisma.helpArticle.findUnique({
      where: { id }
    });
    if (!article) return res.status(404).json({ error: 'Guide article not found.' });
    res.json(article);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch FAQs list
app.get('/api/help/faqs', async (req, res) => {
  try {
    const list = await prisma.fAQ.findMany({
      orderBy: { displayOrder: 'asc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── SYSTEM HEALTH / INCIDENTS BOARD ENDPOINTS ──────────────────────────────

// List all system components with incident counts
app.get('/api/system/components', async (req, res) => {
  try {
    const components = await prisma.systemComponent.findMany({
      include: {
        _count: { select: { incidents: true } },
        incidents: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { name: 'asc' }
    });
    res.json(components);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update a component's status
app.patch('/api/system/components/:id/status', async (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;
  const validStatuses = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    const updated = await prisma.systemComponent.update({
      where: { id },
      data: { status }
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// List incidents for a component (or all)
app.get('/api/system/incidents', async (req, res) => {
  const { componentId } = req.query;
  try {
    const where: any = {};
    if (componentId) where.componentId = parseInt(String(componentId));
    const incidents = await prisma.systemIncident.findMany({
      where,
      include: { component: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(incidents);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Log a new incident
app.post('/api/system/incidents', async (req, res) => {
  const { componentId, title, severity, message, reporter } = req.body;
  if (!componentId || !title || !message) {
    return res.status(400).json({ error: 'componentId, title, and message are required.' });
  }
  try {
    const incident = await prisma.systemIncident.create({
      data: {
        componentId: parseInt(componentId),
        title,
        severity: severity || 'info',
        message,
        reporter: reporter || 'system'
      }
    });
    res.status(201).json(incident);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Resolve an incident
app.patch('/api/system/incidents/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const updated = await prisma.systemIncident.update({
      where: { id },
      data: { severity: 'resolved', resolvedAt: new Date() }
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EMPLOYEES ──────────────────────────────────────────────────────────

app.get('/api/employees', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.employee.findMany({
      where: { companyId },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', async (req, res) => {
  const { companyId, name, role, billingRateToClient, payStructure, payRate } = req.body;
  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId and name are required.' });
  }
  try {
    const employee = await prisma.employee.create({
      data: {
        companyId: parseInt(companyId),
        name,
        role: role || '',
        billingRateToClient: Number(billingRateToClient || 0),
        payStructure: payStructure || 'Per Function',
        payRate: Number(payRate || 0)
      }
    });
    res.status(201).json(employee);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── SITES ──────────────────────────────────────────────────────────────

app.get('/api/sites', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.site.findMany({
      where: { companyId },
      include: {
        siteAssignments: {
          include: {
            employee: true
          }
        }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sites', async (req, res) => {
  const { companyId, name, location, contactPerson, contactInfo, notes } = req.body;
  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId and name are required.' });
  }
  try {
    const site = await prisma.site.create({
      data: {
        companyId: parseInt(companyId),
        name,
        location: location || '',
        contactPerson: contactPerson || '',
        contactInfo: contactInfo || '',
        notes: notes || ''
      }
    });
    res.status(201).json(site);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sites/:id/assign', async (req, res) => {
  const siteId = parseInt(req.params.id);
  const { companyId, employeeId, isPrimary, notes } = req.body;
  if (!companyId || !employeeId) {
    return res.status(400).json({ error: 'companyId and employeeId are required.' });
  }
  try {
    const assignment = await prisma.siteAssignment.upsert({
      where: {
        siteId_employeeId: {
          siteId,
          employeeId: parseInt(employeeId)
        }
      },
      update: {
        isPrimary: !!isPrimary,
        notes: notes || ''
      },
      create: {
        companyId: parseInt(companyId),
        siteId,
        employeeId: parseInt(employeeId),
        isPrimary: !!isPrimary,
        notes: notes || ''
      }
    });
    res.status(201).json(assignment);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EVENTS / FUNCTIONS ──────────────────────────────────────────────────

app.get('/api/functions', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.functionEvent.findMany({
      where: { companyId },
      include: {
        functionAssignments: {
          include: {
            employee: true,
            role: true
          }
        }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/functions', async (req, res) => {
  const { companyId, name, date, time, location, clientName, clientContact, notes } = req.body;
  if (!companyId || !name || !date || !location) {
    return res.status(400).json({ error: 'companyId, name, date, and location are required.' });
  }
  try {
    const fn = await prisma.functionEvent.create({
      data: {
        companyId: parseInt(companyId),
        name,
        date,
        time: time || '',
        location,
        clientName: clientName || '',
        clientContact: clientContact || '',
        notes: notes || '',
        status: 'Scheduled'
      }
    });
    res.status(201).json(fn);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/functions/:id/assign', async (req, res) => {
  const functionId = parseInt(req.params.id);
  const { companyId, employeeId, roleId, startTime, endTime, notes } = req.body;
  if (!companyId || !employeeId || !roleId) {
    return res.status(400).json({ error: 'companyId, employeeId, and roleId are required.' });
  }
  try {
    const assignment = await prisma.functionAssignment.upsert({
      where: {
        functionId_employeeId_roleId: {
          functionId,
          employeeId: parseInt(employeeId),
          roleId: parseInt(roleId)
        }
      },
      update: {
        startTime: startTime || '',
        endTime: endTime || '',
        notes: notes || ''
      },
      create: {
        companyId: parseInt(companyId),
        functionId,
        employeeId: parseInt(employeeId),
        roleId: parseInt(roleId),
        startTime: startTime || '',
        endTime: endTime || '',
        notes: notes || '',
        status: 'Assigned'
      }
    });
    res.status(201).json(assignment);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/function-roles', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.functionRole.findMany({
      where: { companyId }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// ── SUPPLIERS ──────────────────────────────────────────────────────────

app.get('/api/suppliers', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.supplier.findMany({
      where: { companyId },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/suppliers', async (req, res) => {
  const { companyId, name, contactPerson, phone, email, address, notes } = req.body;
  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId and name are required.' });
  }
  try {
    const supplier = await prisma.supplier.create({
      data: {
        companyId: parseInt(companyId),
        name,
        contactPerson: contactPerson || '',
        phone: phone || '',
        email: email || '',
        address: address || '',
        notes: notes || ''
      }
    });
    res.status(201).json(supplier);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── PURCHASE ORDERS ────────────────────────────────────────────────────

app.get('/api/purchase-orders', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.purchaseOrder.findMany({
      where: { companyId },
      include: {
        supplier: true,
        lineItems: {
          include: {
            item: true
          }
        }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchase-orders', async (req, res) => {
  const { companyId, supplierId, poNumber, orderDate, deliveryDate, notes, lineItems } = req.body;
  if (!companyId || !supplierId || !poNumber || !orderDate || !lineItems || !Array.isArray(lineItems)) {
    return res.status(400).json({ error: 'companyId, supplierId, poNumber, orderDate, and lineItems array are required.' });
  }
  try {
    let total = 0;
    const itemsData = lineItems.map((li: any) => {
      const qty = parseInt(li.quantity || 1);
      const unit = Number(li.unitCost || 0);
      const lineCost = qty * unit;
      total += lineCost;
      return {
        companyId: parseInt(companyId),
        itemId: li.itemId ? parseInt(li.itemId) : null,
        description: li.description || '',
        quantity: qty,
        unitCost: unit,
        totalCost: lineCost
      };
    });

    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: parseInt(companyId),
        supplierId: parseInt(supplierId),
        poNumber,
        orderDate,
        deliveryDate: deliveryDate || '',
        totalAmount: total,
        status: 'Draft',
        notes: notes || '',
        lineItems: {
          create: itemsData
        }
      },
      include: {
        lineItems: true
      }
    });
    res.status(201).json(po);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/purchase-orders/:id/status', async (req, res) => {
  const poId = parseInt(req.params.id);
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required.' });

  try {
    const existingPo = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { lineItems: true }
    });

    if (!existingPo) return res.status(404).json({ error: 'Purchase Order not found.' });

    const oldStatus = existingPo.status;
    const newStatus = status;

    if (newStatus === 'Received' && oldStatus !== 'Received') {
      await prisma.$transaction(async (tx) => {
        await tx.purchaseOrder.update({
          where: { id: poId },
          data: { status: newStatus }
        });

        for (const itemLine of existingPo.lineItems) {
          if (itemLine.itemId) {
            await tx.item.update({
              where: { id: itemLine.itemId },
              data: {
                currentStock: {
                  increment: itemLine.quantity
                }
              }
            });
          }
        }
      });
    } else {
      await prisma.purchaseOrder.update({
        where: { id: poId },
        data: { status: newStatus }
      });
    }

    res.json({ success: true, newStatus });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EXPENSES ───────────────────────────────────────────────────────────

app.get('/api/expenses', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.expense.findMany({
      where: { companyId },
      include: {
        supplier: true
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses', async (req, res) => {
  const { companyId, supplierId, amount, expenseCategory, expenseDate, paymentMethod, notes } = req.body;
  if (!companyId || !amount || !expenseCategory || !expenseDate || !paymentMethod) {
    return res.status(400).json({ error: 'companyId, amount, expenseCategory, expenseDate, and paymentMethod are required.' });
  }
  try {
    const exp = await prisma.expense.create({
      data: {
        companyId: parseInt(companyId),
        supplierId: supplierId ? parseInt(supplierId) : null,
        amount: Number(amount),
        expenseCategory,
        expenseDate,
        paymentMethod,
        notes: notes || ''
      }
    });
    res.status(201).json(exp);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── PAYROLL ────────────────────────────────────────────────────────────

app.get('/api/payroll-periods', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.payrollPeriod.findMany({
      where: { companyId },
      include: {
        payments: {
          include: {
            employee: true
          }
        }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payroll-periods', async (req, res) => {
  const { companyId, startDate, endDate } = req.body;
  if (!companyId || !startDate || !endDate) {
    return res.status(400).json({ error: 'companyId, startDate, and endDate are required.' });
  }
  try {
    const events = await prisma.functionEvent.findMany({
      where: {
        companyId: parseInt(companyId),
        date: {
          gte: startDate,
          lte: endDate
        }
      },
      include: {
        functionAssignments: {
          include: {
            employee: true
          }
        }
      }
    });

    const employeeEarnings: Record<number, { amount: number, employeeId: number, notes: string }> = {};

    for (const ev of events) {
      for (const asn of ev.functionAssignments) {
        if (!asn.employee || !asn.employee.isActive) continue;

        const emp = asn.employee;
        const rate = Number(emp.payRate);

        if (!employeeEarnings[emp.id]) {
          employeeEarnings[emp.id] = {
            employeeId: emp.id,
            amount: 0,
            notes: ''
          };
        }

        if (emp.payStructure === 'Per Function') {
          employeeEarnings[emp.id].amount += rate;
          employeeEarnings[emp.id].notes += `Event: "${ev.name}" (Per Function @ UGX ${rate.toLocaleString()}); `;
        } else if (emp.payStructure === 'Daily') {
          employeeEarnings[emp.id].amount += rate;
          employeeEarnings[emp.id].notes += `Date: ${ev.date} (Daily Pay @ UGX ${rate.toLocaleString()}); `;
        } else {
          employeeEarnings[emp.id].amount += rate;
          employeeEarnings[emp.id].notes += `Allocation: ${ev.date} (@ UGX ${rate.toLocaleString()}); `;
        }
      }
    }

    const earningsArray = Object.values(employeeEarnings);
    const totalSpent = earningsArray.reduce((acc, curr) => acc + curr.amount, 0);

    const period = await prisma.$transaction(async (tx) => {
      const newPeriod = await tx.payrollPeriod.create({
        data: {
          companyId: parseInt(companyId),
          startDate,
          endDate,
          status: 'Open',
          totalSpent: totalSpent
        }
      });

      for (const earn of earningsArray) {
        await tx.payrollPayment.create({
          data: {
            companyId: parseInt(companyId),
            payrollPeriodId: newPeriod.id,
            employeeId: earn.employeeId,
            amount: earn.amount,
            status: 'Unpaid',
            notes: earn.notes
          }
        });
      }

      return newPeriod;
    });

    res.status(201).json(period);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/payroll-payments/:id/pay', async (req, res) => {
  const payId = parseInt(req.params.id);
  const { paymentMethod, paymentDate, notes } = req.body;
  if (!paymentMethod || !paymentDate) {
    return res.status(400).json({ error: 'paymentMethod and paymentDate are required.' });
  }
  try {
    const updated = await prisma.payrollPayment.update({
      where: { id: payId },
      data: {
        status: 'Paid',
        paymentMethod,
        paymentDate,
        notes: notes || undefined
      }
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/payroll-periods/:id/status', async (req, res) => {
  const periodId = parseInt(req.params.id);
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required.' });
  try {
    const updated = await prisma.payrollPeriod.update({
      where: { id: periodId },
      data: { status }
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});


app.get('/api/items', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.item.findMany({
      where: { companyId }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create new Item
app.post('/api/items', async (req, res) => {
  const { companyId, name, category, unitOfMeasure, unitCost, unitReplacementCost, dailyRentalRate, currentStock, lowStockThreshold } = req.body;
  try {
    const newItem = await prisma.item.create({
      data: {
        companyId: parseInt(companyId),
        name,
        category,
        unitOfMeasure: unitOfMeasure || "piece",
        unitCost: Number(unitCost || 0),
        unitReplacementCost: Number(unitReplacementCost || 0),
        dailyRentalRate: Number(dailyRentalRate || 0),
        currentStock: parseInt(currentStock || 0),
        lowStockThreshold: parseInt(lowStockThreshold || 5)
      }
    });
    res.status(201).json(newItem);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch all serialized assets
app.get('/api/serialized-assets', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.serializedAsset.findMany({
      where: { companyId }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create new Serialized Asset
app.post('/api/serialized-assets', async (req, res) => {
  const { companyId, name, assetType, serialNumber, costPrice, dailyRentalRate, replacementCost, status } = req.body;
  try {
    const newAsset = await prisma.serializedAsset.create({
      data: {
        companyId: parseInt(companyId),
        name,
        assetType,
        serialNumber,
        costPrice: Number(costPrice || 0),
        dailyRentalRate: Number(dailyRentalRate || 0),
        replacementCost: Number(replacementCost || 0),
        status: status || "Available"
      }
    });
    res.status(201).json(newAsset);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update Serialized Asset details/status
app.patch('/api/serialized-assets/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, assetType, serialNumber, costPrice, dailyRentalRate, replacementCost, status } = req.body;
  try {
    const updatedAsset = await prisma.serializedAsset.update({
      where: { id },
      data: {
        name,
        assetType,
        serialNumber,
        costPrice: costPrice !== undefined ? Number(costPrice) : undefined,
        dailyRentalRate: dailyRentalRate !== undefined ? Number(dailyRentalRate) : undefined,
        replacementCost: replacementCost !== undefined ? Number(replacementCost) : undefined,
        status
      }
    });
    res.json(updatedAsset);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Fetch Bookings list
app.get('/api/bookings', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.booking.findMany({
      where: { companyId },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true,
            consumable: {
              include: {
                packageUnit: true,
                pieceUnit: true,
                unitOfMeasure: true
              }
            },
            unitOfMeasure: true
          }
        }
      }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Create Booking (With Line Items)
app.post('/api/bookings', async (req, res) => {
  const { companyId, customerName, contactInfo, bookingType, scheduledPickupDate, scheduledReturnDate, depositAmount, lineItems } = req.body;
  try {
    const pickup = new Date(scheduledPickupDate);
    const returnD = new Date(scheduledReturnDate);
    const rentalDays = getDaysBetween(pickup, returnD);

    // Split line items by type
    const hireLines = lineItems.filter((li: any) => li.itemType === 'item' || !li.itemType || li.itemType === 'asset');
    const consumableLines = lineItems.filter((li: any) => li.itemType === 'consumable');

    // Fetch hire items from DB
    const itemsDb = hireLines.length > 0 ? await prisma.item.findMany({
      where: { id: { in: hireLines.map((li: any) => li.itemId) } }
    }) : [];

    // Fetch consumables from DB
    const consumablesDb = consumableLines.length > 0 ? await prisma.consumable.findMany({
      where: { id: { in: consumableLines.map((li: any) => li.consumableId) } }
    }) : [];

    let estimatedTotal = 0;
    const parsedLines: any[] = [];

    // 1. Process Hire Line Items
    for (const li of hireLines) {
      const dbItem = itemsDb.find(item => item.id === li.itemId);
      if (!dbItem) throw new Error(`Hire item ${li.itemId} not found in catalog.`);
      
      const rate = Number(dbItem.dailyRentalRate);
      const lineTotal = rate * li.quantity * rentalDays;
      estimatedTotal += lineTotal;

      parsedLines.push({
        itemType: 'item',
        itemId: li.itemId,
        quantity: li.quantity,
        dailyRateAtBooking: rate,
        estimatedRentalDays: rentalDays,
        estimatedLineTotal: lineTotal
      });
    }

    // 2. Process Consumable Line Items
    for (const li of consumableLines) {
      const dbConsumable = consumablesDb.find(c => c.id === li.consumableId);
      if (!dbConsumable) throw new Error(`Consumable item ${li.consumableId} not found in catalog.`);

      // Determine price based on selected UoM
      let rate = Number(dbConsumable.unitPrice);
      if (dbConsumable.isMultiUnit && li.unitOfMeasureId && Number(li.unitOfMeasureId) === dbConsumable.packageUnitId) {
        rate = dbConsumable.packagePrice ? Number(dbConsumable.packagePrice) : Number(dbConsumable.unitPrice);
      }

      const lineTotal = rate * li.quantity;
      estimatedTotal += lineTotal;

      parsedLines.push({
        itemType: 'consumable',
        consumableId: li.consumableId,
        unitOfMeasureId: li.unitOfMeasureId ? parseInt(li.unitOfMeasureId) : null,
        quantity: li.quantity,
        dailyRateAtBooking: rate,
        estimatedRentalDays: 1, // flat sale
        estimatedLineTotal: lineTotal
      });
    }

    const bookingNum = `B-2026-${Math.floor(1000 + Math.random() * 9000)}`;

    const customer = await resolveCustomerByName(customerName, companyId, contactInfo);

    const newBooking = await prisma.booking.create({
      data: {
        companyId,
        customerId: customer.id,
        customerName,
        contactInfo,
        bookingType,
        scheduledPickupDate: pickup,
        scheduledReturnDate: returnD,
        estimatedTotalCost: estimatedTotal,
        depositAmount: depositAmount || 0,
        depositPaid: (depositAmount || 0) > 0,
        depositPaidDate: (depositAmount || 0) > 0 ? new Date() : null,
        bookingNumber: bookingNum,
        status: 'pending',
        lineItems: {
          create: parsedLines
        }
      },
      include: { lineItems: true }
    });

    if (newBooking.depositPaid && Number(newBooking.depositAmount) > 0) {
      await createAccountTransaction({
        customerId: customer.id,
        companyId,
        transactionType: 'booking_deposit',
        amount: -Number(newBooking.depositAmount), // Credit
        description: `Booking Deposit - ${bookingNum}`,
        referenceNumber: bookingNum
      });

      await recordIncome({
        companyId,
        incomeSource: 'booking_deposit',
        amount: Number(newBooking.depositAmount),
        paymentMethod: 'cash',
        referenceNumber: bookingNum,
        description: `Booking Deposit - ${bookingNum}`,
        depositAmount: Number(newBooking.depositAmount)
      });
    }

    // Simulated Email Dispatch for Booking Confirmation
    await logAudit(
      companyId,
      'system',
      'EMAIL_DISPATCH',
      'Booking',
      newBooking.id,
      bookingNum,
      `Simulated booking confirmation email dispatched to ${customerName} (${contactInfo || 'no contact'}). Estimated Total: UGX ${estimatedTotal.toLocaleString()}, Deposit: UGX ${(depositAmount || 0).toLocaleString()}`
    );

    await createNotification({
      companyId, category: 'booking',
      title: `New booking: ${bookingNum}`,
      message: `${customerName} created a booking. Estimated total: ${(estimatedTotal || 0).toLocaleString()}.`,
      link: bookingNum,
    });

    res.status(201).json(newBooking);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 6. Confirm Booking Deposit
app.post('/api/bookings/:id/confirm-deposit', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const customer = await resolveCustomerByName(booking.customerName, booking.companyId, booking.contactInfo || '');

    const updated = await prisma.booking.update({
      where: { id },
      data: {
        customerId: customer.id,
        depositPaid: true,
        depositPaidDate: new Date(),
        status: 'confirmed'
      }
    });

    if (Number(updated.depositAmount) > 0) {
      await createAccountTransaction({
        customerId: customer.id,
        companyId: updated.companyId,
        transactionType: 'booking_deposit',
        amount: -Number(updated.depositAmount), // Credit
        description: `Booking Deposit - ${updated.bookingNumber}`,
        referenceNumber: updated.bookingNumber
      });

      await recordIncome({
        companyId: updated.companyId,
        incomeSource: 'booking_deposit',
        amount: Number(updated.depositAmount),
        paymentMethod: 'cash',
        referenceNumber: updated.bookingNumber,
        description: `Booking Deposit - ${updated.bookingNumber}`,
        depositAmount: Number(updated.depositAmount)
      });

      const company = await prisma.company.findUnique({ where: { id: updated.companyId } });
      await createNotification({
        companyId: updated.companyId, category: 'payment',
        title: `Deposit received: ${updated.bookingNumber}`,
        message: `${updated.customerName} paid a deposit of ${company?.currencySymbol || ''} ${Number(updated.depositAmount).toLocaleString()}.`,
        link: updated.bookingNumber,
      });
    }

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 7. Dispatch Rental Order (Convert Booking)
app.post('/api/bookings/:id/dispatch', async (req, res) => {
  const bookingId = parseInt(req.params.id);
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { lineItems: true }
    });

    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.status === 'converted') return res.status(400).json({ error: "Booking already dispatched." });

    const orderNum = `RO-2026-${Math.floor(1000 + Math.random() * 9000)}`;

    const customer = await resolveCustomerByName(booking.customerName, booking.companyId, booking.contactInfo || '');

    // Create transaction block
    const result = await prisma.$transaction(async (tx) => {
      // Scale and deduct stock for consumable line items
      for (const li of booking.lineItems) {
        if (li.itemType === 'consumable' && li.consumableId) {
          const dbConsumable = await tx.consumable.findUnique({
            where: { id: li.consumableId }
          });
          if (!dbConsumable) throw new Error(`Consumable item not found in catalog.`);
          
          const baseQty = (dbConsumable.isMultiUnit && li.unitOfMeasureId && li.unitOfMeasureId === dbConsumable.packageUnitId)
            ? li.quantity * dbConsumable.unitRatio
            : li.quantity;

          if (dbConsumable.stockQty < baseQty) {
            throw new Error(`Insufficient stock for consumable "${dbConsumable.name}". Available: ${dbConsumable.stockQty}, Required: ${baseQty}`);
          }

          // Decrement stockQty
          await tx.consumable.update({
            where: { id: li.consumableId },
            data: { stockQty: { decrement: baseQty } }
          });

          // Log the stock usage
          await tx.consumableLog.create({
            data: {
              consumableId: li.consumableId,
              action: 'use',
              quantity: baseQty,
              operator: 'system',
              notes: `Sold ${li.quantity} ${li.unitOfMeasureId === dbConsumable.packageUnitId ? 'Big Unit' : 'Small Unit'} (${baseQty} base units) in Order #${orderNum} (Booking #${booking.bookingNumber})`
            }
          });

          // Record Cost of Goods Sold (COGS) Expense if costPrice is set
          const totalCost = Number(dbConsumable.costPrice) * baseQty;
          if (totalCost > 0) {
            await tx.expense.create({
              data: {
                companyId: booking.companyId,
                amount: totalCost,
                expenseCategory: 'Cost of Goods Sold',
                expenseDate: new Date().toISOString().split('T')[0],
                paymentMethod: 'internal',
                notes: `COGS: ${li.quantity} x ${dbConsumable.name} (Sold in Order #${orderNum})`
              }
            });
          }
        }
      }

      // Deduct on-hand stock for bulk items and mark serialized assets as Rented.
      // currentStock represents available inventory; the reconciliation return
      // restocks good returns and leaves damaged/lost units out.
      for (const li of booking.lineItems) {
        if (li.itemType === 'item' && li.itemId) {
          const dbItem = await tx.item.findUnique({ where: { id: li.itemId } });
          if (!dbItem) throw new Error('Rental item not found in catalog.');
          if (dbItem.currentStock < li.quantity) {
            throw new Error(`Insufficient stock for "${dbItem.name}". Available: ${dbItem.currentStock}, Required: ${li.quantity}.`);
          }
          await tx.item.update({ where: { id: li.itemId }, data: { currentStock: { decrement: li.quantity } } });
        } else if (li.itemType === 'asset' && li.assetId) {
          await tx.serializedAsset.update({ where: { id: li.assetId }, data: { status: 'Rented' } });
        }
      }

      // Create Rental Order
      const order = await tx.rentalOrder.create({
        data: {
          companyId: booking.companyId,
          customerId: customer.id,
          customerName: booking.customerName,
          checkoutDate: new Date(),
          expectedReturnDate: booking.scheduledReturnDate || new Date(),
          status: 'Active',
          companyOrderNumber: orderNum,
          estimatedTotal: booking.estimatedTotalCost,
          totalAmountPaid: booking.depositAmount,
          lineItems: {
            create: booking.lineItems.map(li => ({
              itemType: li.itemType,
              itemId: li.itemId,
              assetId: li.assetId,
              consumableId: li.consumableId,
              unitOfMeasureId: li.unitOfMeasureId,
              quantity: li.quantity,
              dailyRate: li.dailyRateAtBooking,
              rentedQty: li.itemType === 'consumable' ? 0 : li.quantity // consumables are sold off and not expected back
            }))
          }
        }
      });

      // Update Booking
      await tx.booking.update({
        where: { id: bookingId },
        data: {
          customerId: customer.id,
          status: 'converted',
          convertedRentalOrderId: order.id
        }
      });

      // Create Invoice for remaining balance
      const balance = Number(booking.estimatedTotalCost) - Number(booking.depositAmount);
      if (balance > 0) {
        await tx.invoice.create({
          data: {
            companyId: booking.companyId,
            referenceNumber: `INV-2026-${Math.floor(1000 + Math.random() * 9000)}`,
            customerName: booking.customerName,
            amount: balance,
            dueDate: booking.scheduledReturnDate || new Date(),
            status: 'Unpaid',
            description: `Balance on Rental Order #${orderNum}`
          }
        });
      }

      return order;
    });

    // Record the debit transaction in the ledger (the full rental order cost is charged)
    const account = await getOrCreateCustomerAccount(customer.id, booking.companyId);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + account.paymentTermsDays);

    await createAccountTransaction({
      customerId: customer.id,
      companyId: booking.companyId,
      transactionType: 'invoice',
      amount: Number(booking.estimatedTotalCost), // Debit
      description: `Rental Order #${orderNum}`,
      dueDate,
      referenceNumber: orderNum
    });

    // Low-stock alerts for any bulk items that just went out
    for (const li of booking.lineItems) {
      if (li.itemType === 'item' && li.itemId) await checkItemLowStock(li.itemId, booking.companyId);
    }

    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 8. Fetch Rental Orders
app.get('/api/rental-orders', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.rentalOrder.findMany({
      where: { companyId },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true,
            consumable: {
              include: {
                packageUnit: true,
                pieceUnit: true,
                unitOfMeasure: true
              }
            },
            unitOfMeasure: true
          }
        }
      }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8b. Fetch overdue rental orders with days overdue computed
app.get('/api/rental-orders/overdue', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const now = new Date();
    const overdueOrders = await prisma.rentalOrder.findMany({
      where: {
        companyId,
        status: { in: ['Active', 'Overdue'] },
        expectedReturnDate: { lt: now },
        actualReturnDate: null
      },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true,
            consumable: {
              include: {
                packageUnit: true,
                pieceUnit: true,
                unitOfMeasure: true
              }
            },
            unitOfMeasure: true
          }
        }
      },
      orderBy: { expectedReturnDate: 'asc' }
    });

    const enriched = overdueOrders.map(order => {
      const daysOverdue = Math.max(0, Math.ceil(
        (now.getTime() - new Date(order.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
      ));
      // 10% of daily rate per day overdue for each line item
      const projectedLateFee = order.lineItems.reduce((sum, li) => {
        return sum + (Number(li.dailyRate) * 0.10 * daysOverdue * li.rentedQty);
      }, 0);
      return { ...order, daysOverdue, projectedLateFee: Math.round(projectedLateFee) };
    });

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8c. Dashboard overdue summary (count + total projected fees)
app.get('/api/dashboard/overdue-alerts', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const now = new Date();
    const overdueOrders = await prisma.rentalOrder.findMany({
      where: {
        companyId,
        status: { in: ['Active', 'Overdue'] },
        expectedReturnDate: { lt: now },
        actualReturnDate: null
      },
      include: { lineItems: true }
    });

    let totalProjectedFees = 0;
    const overdueList = overdueOrders.map(order => {
      const daysOverdue = Math.max(0, Math.ceil(
        (now.getTime() - new Date(order.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
      ));
      const projectedLateFee = order.lineItems.reduce((sum, li) => {
        return sum + (Number(li.dailyRate) * 0.10 * daysOverdue * li.rentedQty);
      }, 0);
      totalProjectedFees += projectedLateFee;
      return {
        id: order.id,
        companyOrderNumber: order.companyOrderNumber,
        customerName: order.customerName,
        expectedReturnDate: order.expectedReturnDate,
        daysOverdue,
        projectedLateFee: Math.round(projectedLateFee)
      };
    });

    res.json({
      overdueCount: overdueOrders.length,
      totalProjectedFees: Math.round(totalProjectedFees),
      orders: overdueList.sort((a, b) => b.daysOverdue - a.daysOverdue)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8d. Apply / recalculate late fee on a specific overdue order
app.post('/api/rental-orders/:id/apply-late-fee', async (req, res) => {
  const companyId = getCompanyId(req);
  const orderId = parseInt(req.params.id);
  try {
    const order = await prisma.rentalOrder.findFirst({
      where: { id: orderId, companyId },
      include: { lineItems: true, company: true }
    });
    if (!order) return res.status(404).json({ error: 'Rental order not found.' });

    const now = new Date();
    const refDate = order.actualReturnDate || now;
    // Shared formula + company-configurable rate (kept in sync with the return endpoint).
    const { lateFee, daysOverdue } = computeLateFee(
      order.lineItems, order.expectedReturnDate, refDate, Number(order.company.lateFeePercentPerDay)
    );

    const updated = await prisma.rentalOrder.update({
      where: { id: orderId },
      data: {
        totalLateFeeCalculated: lateFee,
        lateFeeAppliedAt: now,
        status: daysOverdue > 0 && !order.actualReturnDate ? 'Overdue' : order.status
      }
    });

    await logAudit(companyId, 'system', 'LATE_FEE_APPLIED', 'RentalOrder', orderId, order.companyOrderNumber,
      `Late fee of ${order.company.currencySymbol} ${lateFee.toLocaleString()} applied for ${daysOverdue} overdue day(s).`);

    // Idempotent ledger charge + penalty invoice (deterministic references).
    await chargeLedgerOnce(order.customerId, companyId, 'late_fee',
      `${order.companyOrderNumber}-LF`, lateFee,
      `Late return penalty on Order #${order.companyOrderNumber} (${daysOverdue} day(s))`, now);

    if (lateFee > 0) {
      await upsertPenaltyInvoice(companyId, `LFEE-${order.companyOrderNumber}`,
        order.customerName, lateFee,
        `Late return penalty — Order #${order.companyOrderNumber} — ${daysOverdue} day(s) overdue`, now);
    }

    res.json({ ...updated, daysOverdue, lateFeeApplied: lateFee });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// 9. Process Rental Order Return with per-line reconciliation.
// Body: { lines?: [{ lineItemId, returnedQty, damagedQty, lostQty }], notes? }
// If `lines` is omitted, each line's full outstanding quantity is treated as
// returned in good condition (backward-compatible one-click "return all").
//
// Fees are read from the company's configurable policy (Settings):
//   • late fee  = Σ dailyRate × lateFeePercentPerDay% × daysOverdue × rentedQty
//   • damage fee = Σ damagedQty × replacementCost × damageFeePercent%
//   • lost fee   = Σ lostQty    × replacementCost × lostFeePercent%
app.post('/api/rental-orders/:id/return', async (req, res) => {
  const id = parseInt(req.params.id);
  const companyId = getCompanyId(req);
  const { lines, notes } = req.body || {};
  try {
    const order = await prisma.rentalOrder.findFirst({
      where: { id, companyId },
      include: { lineItems: { include: { item: true, asset: true } }, company: true }
    });

    if (!order) return res.status(404).json({ error: "Rental order not found." });
    const openStatuses = ['Active', 'Overdue', 'Partially Returned'];
    if (!openStatuses.includes(order.status)) {
      return res.status(400).json({ error: "Rental order is already returned/finalized." });
    }

    const company = order.company;
    const damagePct = Number(company.damageFeePercent) / 100;
    const lostPct = Number(company.lostFeePercent) / 100;
    const restock = company.restockReturnedItems;
    const now = new Date();

    // Index reconciliation input by line-item id.
    const inputById = new Map<number, { returnedQty: number; damagedQty: number; lostQty: number }>();
    if (Array.isArray(lines)) {
      for (const l of lines) {
        inputById.set(Number(l.lineItemId), {
          returnedQty: Math.max(0, parseInt(l.returnedQty) || 0),
          damagedQty: Math.max(0, parseInt(l.damagedQty) || 0),
          lostQty: Math.max(0, parseInt(l.lostQty) || 0),
        });
      }
    }

    // Validate + compute fees (money math outside the tx).
    let damageFee = 0, lostFee = 0;
    const recLines: Array<{ li: any; inp: { returnedQty: number; damagedQty: number; lostQty: number } }> = [];
    for (const li of order.lineItems) {
      if (li.itemType === 'consumable') continue; // sold off, never expected back
      const outstanding = (li.rentedQty || 0) - (li.returnedQty + li.damagedQty + li.lostQty);
      if (outstanding <= 0) continue;

      const inp = inputById.get(li.id) || { returnedQty: outstanding, damagedQty: 0, lostQty: 0 };
      const total = inp.returnedQty + inp.damagedQty + inp.lostQty;
      if (total > outstanding) {
        return res.status(400).json({
          error: `Line item ${li.id}: reconciled quantity (${total}) exceeds outstanding rented quantity (${outstanding}).`
        });
      }
      if (total === 0) continue;

      const replacementUnit = li.itemType === 'asset'
        ? Number(li.asset?.replacementCost || 0)
        : Number(li.item?.unitReplacementCost || 0);
      damageFee += inp.damagedQty * replacementUnit * damagePct;
      lostFee += inp.lostQty * replacementUnit * lostPct;
      recLines.push({ li, inp });
    }

    if (recLines.length === 0) {
      return res.status(400).json({ error: "Nothing to reconcile — all rented items are already accounted for." });
    }

    const { lateFee, daysOverdue } = computeLateFee(
      order.lineItems, order.expectedReturnDate, now, Number(company.lateFeePercentPerDay)
    );
    const replacementFee = Math.round(damageFee + lostFee);

    // Apply line updates, inventory adjustments and order status atomically.
    const updated = await prisma.$transaction(async (tx) => {
      for (const { li, inp } of recLines) {
        await tx.rentalLineItem.update({
          where: { id: li.id },
          data: {
            returnedQty: { increment: inp.returnedQty },
            damagedQty: { increment: inp.damagedQty },
            lostQty: { increment: inp.lostQty },
          }
        });

        if (li.itemType === 'asset' && li.assetId) {
          // Serialized (single-unit) asset: set its terminal status.
          let status: string | null = null;
          if (inp.lostQty > 0) status = 'Lost';
          else if (inp.damagedQty > 0) status = 'Maintenance';
          else if (restock) status = 'Available';
          if (status) await tx.serializedAsset.update({ where: { id: li.assetId }, data: { status } });
        } else if (li.itemType === 'item' && li.itemId) {
          // Bulk item: all rented units were deducted from on-hand stock at dispatch.
          // Good returns come back into inventory (if restock is enabled); damaged and
          // lost units stay out (they don't return to sellable/rentable stock).
          if (restock && inp.returnedQty > 0) {
            await tx.item.update({
              where: { id: li.itemId },
              data: { currentStock: { increment: inp.returnedQty } }
            });
          }
        }
      }

      // Determine whether every rentable line is now fully accounted for.
      let fullyReconciled = true;
      for (const li of order.lineItems) {
        if (li.itemType === 'consumable') continue;
        const applied = recLines.find(r => r.li.id === li.id)?.inp;
        const accounted = li.returnedQty + li.damagedQty + li.lostQty
          + (applied ? applied.returnedQty + applied.damagedQty + applied.lostQty : 0);
        if (accounted < (li.rentedQty || 0)) fullyReconciled = false;
      }

      return tx.rentalOrder.update({
        where: { id },
        data: {
          status: fullyReconciled ? 'Returned' : 'Partially Returned',
          actualReturnDate: fullyReconciled ? now : order.actualReturnDate,
          totalLateFeeCalculated: lateFee,
          totalReplacementFeeCalculated: replacementFee,
          isFullyReconciled: fullyReconciled,
        }
      });
    });

    // Ledger charges + penalty invoices (idempotent by deterministic reference).
    if (lateFee > 0) {
      await chargeLedgerOnce(order.customerId, companyId, 'late_fee',
        `${order.companyOrderNumber}-LF`, lateFee,
        `Late return penalty on Order #${order.companyOrderNumber} (${daysOverdue} day(s))`, now);
      await upsertPenaltyInvoice(companyId, `LFEE-${order.companyOrderNumber}`,
        order.customerName, lateFee,
        `Late return penalty — Order #${order.companyOrderNumber} — ${daysOverdue} day(s) overdue`, now);
    }
    if (replacementFee > 0) {
      await chargeLedgerOnce(order.customerId, companyId, 'damage_fee',
        `${order.companyOrderNumber}-DF`, replacementFee,
        `Damage/loss recovery on Order #${order.companyOrderNumber}`, now);
      await upsertPenaltyInvoice(companyId, `DMG-${order.companyOrderNumber}`,
        order.customerName, replacementFee,
        `Damage & loss recovery — Order #${order.companyOrderNumber}`, now);
    }

    await logAudit(companyId, 'system', 'RETURN_RECONCILED', 'RentalOrder', order.id, order.companyOrderNumber,
      `Return reconciled — status: ${updated.status}. Late fee: ${company.currencySymbol} ${lateFee.toLocaleString()}, Damage/loss: ${company.currencySymbol} ${replacementFee.toLocaleString()}.${notes ? ' Notes: ' + notes : ''}`);

    // Notify: return processed (highlight damage/loss when present)
    const damagedLost = recLines.reduce((s, r) => s + r.inp.damagedQty + r.inp.lostQty, 0);
    await createNotification({
      companyId, category: 'return',
      title: `Return processed: Order #${order.companyOrderNumber}`,
      message: damagedLost > 0
        ? `${order.customerName}'s return reconciled with ${damagedLost} damaged/lost unit(s). Recovery charged: ${company.currencySymbol} ${replacementFee.toLocaleString()}.`
        : `${order.customerName}'s return reconciled cleanly (${updated.status}).`,
      link: order.companyOrderNumber,
    });

    // Re-check low stock for any restocked/affected items
    for (const { li } of recLines) {
      if (li.itemType === 'item' && li.itemId) await checkItemLowStock(li.itemId, companyId);
    }

    res.json({ ...updated, lateFee, replacementFee, daysOverdue });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Reconciliation register: orders with recorded damage/loss or an incomplete
// return (partially returned / still-outstanding units). Feeds the Alerts view.
app.get('/api/reconciliations', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const orders = await prisma.rentalOrder.findMany({
      where: { companyId },
      include: { lineItems: { include: { item: true, asset: true } } },
      orderBy: { checkoutDate: 'desc' }
    });

    const register = orders
      .map(o => {
        const rentable = o.lineItems.filter(li => li.itemType !== 'consumable');
        const rented = rentable.reduce((s, li) => s + (li.rentedQty || 0), 0);
        const returned = rentable.reduce((s, li) => s + li.returnedQty, 0);
        const damaged = rentable.reduce((s, li) => s + li.damagedQty, 0);
        const lost = rentable.reduce((s, li) => s + li.lostQty, 0);
        const outstanding = rented - returned - damaged - lost;
        return {
          id: o.id,
          companyOrderNumber: o.companyOrderNumber,
          customerName: o.customerName,
          status: o.status,
          checkoutDate: o.checkoutDate,
          expectedReturnDate: o.expectedReturnDate,
          actualReturnDate: o.actualReturnDate,
          isFullyReconciled: o.isFullyReconciled,
          totalLateFeeCalculated: Number(o.totalLateFeeCalculated),
          totalReplacementFeeCalculated: Number(o.totalReplacementFeeCalculated),
          rented, returned, damaged, lost, outstanding,
        };
      })
      // Only surface rows that need attention: any damage/loss, or an unfinished return.
      .filter(r => r.damaged > 0 || r.lost > 0 || r.status === 'Partially Returned' ||
        (r.status !== 'Returned' && r.status !== 'Cancelled' && r.outstanding > 0 && r.rented > 0));

    res.json(register);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Fetch Invoices
app.get('/api/invoices', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.invoice.findMany({
      where: { companyId }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── SERVER-SIDE PDF DOCUMENTS ──────────────────────────────────────────────

// Downloadable invoice PDF
app.get('/api/invoices/:id/pdf', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), companyId } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    streamInvoicePdf(res, company, invoice as any);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Downloadable booking / deposit receipt PDF
app.get('/api/bookings/:id/receipt-pdf', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const booking = await prisma.booking.findFirst({ where: { id: parseInt(req.params.id), companyId } });
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    streamBookingReceiptPdf(res, company, booking as any);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Downloadable rental-order / dispatch note PDF
app.get('/api/rental-orders/:id/pdf', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const order = await prisma.rentalOrder.findFirst({
      where: { id: parseInt(req.params.id), companyId },
      include: { lineItems: { include: { item: true, asset: true, consumable: true } } }
    });
    if (!order) return res.status(404).json({ error: 'Rental order not found.' });
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    streamRentalOrderPdf(res, company, order as any);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 11. Issue Credit Note
app.post('/api/invoices/:id/credit-memo', async (req, res) => {
  const id = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id }
    });

    if (!invoice) return res.status(404).json({ error: "Invoice not found." });

    const creditNoteNum = `CN-2026-${Math.floor(1000 + Math.random() * 9000)}`;

    const result = await prisma.$transaction(async (tx) => {
      // Create Credit Note
      const note = await tx.creditNote.create({
        data: {
          companyId: invoice.companyId,
          referenceNumber: creditNoteNum,
          customerName: invoice.customerName,
          amount: invoice.amount,
          reason: reason || "Billing adjustment",
          createdAt: new Date()
        }
      });

      // Close Invoice
      await tx.invoice.update({
        where: { id },
        data: { status: 'Paid' }
      });

      return note;
    });

    // Log credit note to customer ledger
    const customer = await resolveCustomerByName(invoice.customerName, invoice.companyId);
    await createAccountTransaction({
      customerId: customer.id,
      companyId: invoice.companyId,
      transactionType: 'credit_memo',
      amount: -Number(invoice.amount), // Credit
      description: `Credit Memo - ${creditNoteNum} (${reason || 'Billing adjustment'})`,
      referenceNumber: creditNoteNum
    });

    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/invoices/:id/pay', async (req, res) => {
  const id = parseInt(req.params.id);
  const { paymentMethod, paymentDate, notes } = req.body;
  if (!paymentMethod || !paymentDate) {
    return res.status(400).json({ error: 'paymentMethod and paymentDate are required.' });
  }
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id }
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });

    const updated = await prisma.invoice.update({
      where: { id },
      data: {
        status: 'Paid',
        paymentMethod,
        paymentDate: new Date(paymentDate),
        paymentNotes: notes || ''
      }
    });

    // Log payment to customer ledger
    const customer = await resolveCustomerByName(invoice.customerName, invoice.companyId);
    await createAccountTransaction({
      customerId: customer.id,
      companyId: invoice.companyId,
      transactionType: 'payment',
      amount: -Number(invoice.amount), // Credit
      description: `Invoice Payment - ${invoice.referenceNumber} (${paymentMethod})`,
      referenceNumber: invoice.referenceNumber
    });

    await recordIncome({
      companyId: invoice.companyId,
      incomeSource: 'invoice_payment',
      amount: Number(invoice.amount),
      paymentMethod,
      referenceNumber: invoice.referenceNumber,
      description: `Invoice Payment - ${invoice.referenceNumber} (${paymentMethod})`,
      baseRentalAmount: Number(invoice.amount)
    });

    await logAudit(
      invoice.companyId,
      'system',
      'EMAIL_DISPATCH',
      'Invoice',
      invoice.id,
      invoice.referenceNumber,
      `Simulated invoice payment receipt email dispatched to ${invoice.customerName}. Amount Paid: UGX ${Number(invoice.amount).toLocaleString()} via ${paymentMethod}. notes: ${notes || 'none'}`
    );

    const company = await prisma.company.findUnique({ where: { id: invoice.companyId } });
    await createNotification({
      companyId: invoice.companyId, category: 'payment',
      title: `Payment received: ${invoice.referenceNumber}`,
      message: `${invoice.customerName} paid ${company?.currencySymbol || ''} ${Number(invoice.amount).toLocaleString()} via ${paymentMethod}.`,
      link: invoice.referenceNumber,
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// CSV Export Customers
app.get('/api/export/customers', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.customer.findMany({
      where: { companyId }
    });
    let csv = 'id,name,contactInfo,watchListReason,isOnWatchList\n';
    list.forEach(c => {
      const name = `"${c.name.replace(/"/g, '""')}"`;
      const contact = `"${(c.contactInfo || '').replace(/"/g, '""')}"`;
      const reason = `"${(c.watchListReason || '').replace(/"/g, '""')}"`;
      csv += `${c.id},${name},${contact},${reason},${c.isOnWatchList}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// CSV Export Catalog Items
app.get('/api/export/items', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.item.findMany({
      where: { companyId }
    });
    let csv = 'name,category,unitOfMeasure,unitCost,unitReplacementCost,dailyRentalRate,currentStock,lowStockThreshold\n';
    list.forEach(i => {
      const name = `"${i.name.replace(/"/g, '""')}"`;
      const category = `"${i.category.replace(/"/g, '""')}"`;
      csv += `${name},${category},${i.unitOfMeasure},${i.unitCost},${i.unitReplacementCost},${i.dailyRentalRate},${i.currentStock},${i.lowStockThreshold}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=items.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk Import Customers
app.post('/api/import/customers', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'data array is required.' });
  }
  try {
    const created = await prisma.customer.createMany({
      data: data.map((c: any) => ({
        companyId,
        name: c.name || 'Unnamed Customer',
        contactInfo: c.contactInfo || '',
        isOnWatchList: c.isOnWatchList === true || c.isOnWatchList === 'true',
        watchListReason: c.watchListReason || ''
      }))
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Bulk Import Catalog Items
app.post('/api/import/items', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'data array is required.' });
  }
  try {
    const created = await prisma.item.createMany({
      data: data.map((i: any) => ({
        companyId,
        name: i.name || 'Unnamed Item',
        category: i.category || 'General',
        unitOfMeasure: i.unitOfMeasure || 'piece',
        unitCost: Number(i.unitCost || 0),
        unitReplacementCost: Number(i.unitReplacementCost || 0),
        dailyRentalRate: Number(i.dailyRentalRate || 0),
        currentStock: parseInt(i.currentStock || '0'),
        lowStockThreshold: parseInt(i.lowStockThreshold || '5')
      }))
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Helper: CSV-escape a value
function csvCell(v: any): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// ── SERIALIZED ASSETS import / export ──────────────────────────────────────
app.get('/api/export/assets', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.serializedAsset.findMany({ where: { companyId } });
    let csv = 'name,assetType,serialNumber,costPrice,dailyRentalRate,replacementCost,status\n';
    list.forEach(a => {
      csv += `${csvCell(a.name)},${csvCell(a.assetType)},${csvCell(a.serialNumber)},${a.costPrice},${a.dailyRentalRate},${a.replacementCost},${csvCell(a.status)}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=assets.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import/assets', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'data array is required.' });
  try {
    const created = await prisma.serializedAsset.createMany({
      data: data.map((a: any) => ({
        companyId,
        name: a.name || 'Unnamed Asset',
        assetType: a.assetType || 'General',
        serialNumber: a.serialNumber || `SN-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        costPrice: Number(a.costPrice || 0),
        dailyRentalRate: Number(a.dailyRentalRate || 0),
        replacementCost: Number(a.replacementCost || 0),
        status: a.status || 'Available',
      }))
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── CONSUMABLES import / export ────────────────────────────────────────────
app.get('/api/export/consumables', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.consumable.findMany({ where: { companyId } });
    let csv = 'name,category,stockQty,restockLevel,unitPrice,costPrice,sku\n';
    list.forEach(c => {
      csv += `${csvCell(c.name)},${csvCell(c.category)},${c.stockQty},${c.restockLevel},${c.unitPrice},${c.costPrice},${csvCell(c.sku)}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=consumables.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import/consumables', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'data array is required.' });
  try {
    const created = await prisma.consumable.createMany({
      data: data.map((c: any) => ({
        companyId,
        name: c.name || 'Unnamed Consumable',
        category: c.category || 'general',
        stockQty: parseInt(c.stockQty || '0'),
        restockLevel: parseInt(c.restockLevel || '0'),
        unitPrice: Number(c.unitPrice || 0),
        costPrice: Number(c.costPrice || 0),
        sku: c.sku || null,
      }))
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EMPLOYEES import / export ──────────────────────────────────────────────
app.get('/api/export/employees', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.employee.findMany({ where: { companyId } });
    let csv = 'name,role,billingRateToClient,payStructure,payRate,isActive\n';
    list.forEach(e => {
      csv += `${csvCell(e.name)},${csvCell(e.role)},${e.billingRateToClient},${csvCell(e.payStructure)},${e.payRate},${e.isActive}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=employees.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import/employees', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'data array is required.' });
  try {
    const created = await prisma.employee.createMany({
      data: data.map((e: any) => ({
        companyId,
        name: e.name || 'Unnamed Employee',
        role: e.role || null,
        billingRateToClient: Number(e.billingRateToClient || 0),
        payStructure: e.payStructure || 'Per Function',
        payRate: Number(e.payRate || 0),
        isActive: e.isActive === undefined ? true : (e.isActive === true || String(e.isActive).toLowerCase() === 'true'),
      }))
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 12. Fetch Credit Notes
app.get('/api/credit-notes', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.creditNote.findMany({
      where: { companyId }
    });
    res.json(list);
  } catch (err: any) {
    res.status(505).json({ error: err.message });
  }
});

// 12.5 Dashboard Stats (Dynamic Analytics Report)
app.get('/api/reports/dashboard-stats', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { startDate, endDate, category, customerName } = req.query;

    const start = startDate ? new Date(startDate as string) : null;
    const end = endDate ? new Date(endDate as string) : null;
    const cat = category ? (category as string).toLowerCase() : null;
    const cust = customerName ? (customerName as string).toLowerCase() : null;

    // 1. Fetch matching rental orders for Active Rental Income
    const rentalOrders = await prisma.rentalOrder.findMany({
      where: { companyId },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true
          }
        }
      }
    });

    let filteredOrders = rentalOrders;
    if (start) {
      filteredOrders = filteredOrders.filter(o => new Date(o.checkoutDate) >= start);
    }
    if (end) {
      filteredOrders = filteredOrders.filter(o => new Date(o.checkoutDate) <= end);
    }
    if (cust) {
      filteredOrders = filteredOrders.filter(o => o.customerName.toLowerCase().includes(cust));
    }
    if (cat) {
      filteredOrders = filteredOrders.filter(o => 
        o.lineItems.some(li => 
          (li.item && li.item.category.toLowerCase() === cat) ||
          (li.asset && li.asset.assetType.toLowerCase() === cat)
        )
      );
    }

    const activeRentalIncome = filteredOrders.reduce((sum, o) => sum + Number(o.estimatedTotal), 0);

    // 2. Fetch deposits collected
    const bookings = await prisma.booking.findMany({
      where: {
        companyId,
        depositPaid: true
      },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true
          }
        }
      }
    });

    let filteredBookings = bookings;
    if (start) {
      filteredBookings = filteredBookings.filter(b => b.depositPaidDate && new Date(b.depositPaidDate) >= start);
    }
    if (end) {
      filteredBookings = filteredBookings.filter(b => b.depositPaidDate && new Date(b.depositPaidDate) <= end);
    }
    if (cust) {
      filteredBookings = filteredBookings.filter(b => b.customerName.toLowerCase().includes(cust));
    }
    if (cat) {
      filteredBookings = filteredBookings.filter(b =>
        b.lineItems.some(li => 
          (li.item && li.item.category.toLowerCase() === cat) ||
          (li.asset && li.asset.assetType.toLowerCase() === cat)
        )
      );
    }

    const depositsCollected = filteredBookings.reduce((sum, b) => sum + Number(b.depositAmount), 0);

    // 3. Fetch outstanding invoices
    const invoices = await prisma.invoice.findMany({
      where: {
        companyId,
        status: 'Unpaid'
      }
    });

    let filteredInvoices = invoices;
    if (start) {
      filteredInvoices = filteredInvoices.filter(i => new Date(i.dueDate) >= start);
    }
    if (end) {
      filteredInvoices = filteredInvoices.filter(i => new Date(i.dueDate) <= end);
    }
    if (cust) {
      filteredInvoices = filteredInvoices.filter(i => i.customerName.toLowerCase().includes(cust));
    }

    const outstandingInvoices = filteredInvoices.reduce((sum, i) => sum + Number(i.amount), 0);

    // 4. Fetch asset utilization
    let assetWhere: any = { companyId };
    if (cat) {
      assetWhere.assetType = { equals: category as string };
    }
    const totalAssets = await prisma.serializedAsset.count({
      where: assetWhere
    });
    const rentedAssets = await prisma.serializedAsset.count({
      where: {
        ...assetWhere,
        status: 'Rented'
      }
    });

    const assetUtilization = totalAssets > 0 ? (rentedAssets / totalAssets) * 100 : 0.0;

    // 5. Build dynamic utilization chart from database
    const itemsList = await prisma.item.findMany({
      where: { companyId }
    });
    const activeRentalLineItems = await prisma.rentalLineItem.findMany({
      where: {
        order: {
          status: 'Active',
          companyId
        }
      }
    });

    let utilizationChart = itemsList.map(item => {
      const itemLines = activeRentalLineItems.filter(li => li.itemId === item.id);
      const totalRented = itemLines.reduce((sum, li) => sum + (li.rentedQty - li.returnedQty), 0);
      // currentStock is now on-hand availability; total capacity = available + rented-out.
      const capacity = (item.currentStock || 0) + totalRented || 1;
      const percent = Math.min(100, Math.max(0, parseFloat(((totalRented / capacity) * 100).toFixed(1))));
      return {
        name: item.name,
        percent,
        rented: totalRented,
        stock: capacity,
        category: item.category
      };
    });

    if (cat) {
      utilizationChart = utilizationChart.filter(u => u.category.toLowerCase() === cat);
    }

    res.json({
      activeRentalIncome,
      depositsCollected,
      outstandingInvoices,
      assetUtilization: parseFloat(assetUtilization.toFixed(1)),
      utilizationChart
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Invoice Aging Report
app.get('/api/reports/invoice-aging', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const invoices = await prisma.invoice.findMany({
      where: { status: 'Unpaid', companyId }
    });

    const now = new Date();
    let current = 0;
    let overdue1to30 = 0;
    let overdue31to60 = 0;
    let overdue61to90 = 0;
    let overdue90Plus = 0;

    for (const inv of invoices) {
      const due = new Date(inv.dueDate);
      const diffTime = now.getTime() - due.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const amount = Number(inv.amount);

      if (diffDays <= 0) {
        current += amount;
      } else if (diffDays <= 30) {
        overdue1to30 += amount;
      } else if (diffDays <= 60) {
        overdue31to60 += amount;
      } else if (diffDays <= 90) {
        overdue61to90 += amount;
      } else {
        overdue90Plus += amount;
      }
    }

    res.json({
      current,
      overdue1to30,
      overdue31to60,
      overdue61to90,
      overdue90Plus,
      totalUnpaid: current + overdue1to30 + overdue31to60 + overdue61to90 + overdue90Plus
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Site-activity report: per-site staff assignments + roster (JSON for display)
app.get('/api/reports/site-activity', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const sites = await prisma.site.findMany({
      where: { companyId },
      include: { siteAssignments: { include: { employee: true } } },
      orderBy: { name: 'asc' },
    });
    const report = sites.map(s => ({
      id: s.id, name: s.name, location: s.location || '', contactPerson: s.contactPerson || '',
      contactInfo: s.contactInfo || '', staffCount: s.siteAssignments.length,
      primaryStaff: s.siteAssignments.filter(a => a.isPrimary).map(a => a.employee.name),
      staff: s.siteAssignments.map(a => ({ name: a.employee.name, role: a.employee.role, isPrimary: a.isPrimary })),
    }));
    res.json({ report, totals: { sites: sites.length, assignments: report.reduce((n, r) => n + r.staffCount, 0) } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Site-activity report as CSV (one row per site→staff assignment)
app.get('/api/export/site-activity', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const sites = await prisma.site.findMany({
      where: { companyId },
      include: { siteAssignments: { include: { employee: true } } },
      orderBy: { name: 'asc' },
    });
    let csv = 'site,location,contactPerson,contactInfo,staffName,staffRole,isPrimary\n';
    sites.forEach(s => {
      if (s.siteAssignments.length === 0) {
        csv += `${csvCell(s.name)},${csvCell(s.location)},${csvCell(s.contactPerson)},${csvCell(s.contactInfo)},,,\n`;
      } else {
        s.siteAssignments.forEach(a => {
          csv += `${csvCell(s.name)},${csvCell(s.location)},${csvCell(s.contactPerson)},${csvCell(s.contactInfo)},${csvCell(a.employee.name)},${csvCell(a.employee.role)},${a.isPrimary}\n`;
        });
      }
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=site-activity-report.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Boot Lifecycle
async function startServer() {
  try {
    // 1. Ensure MariaDB database exists
    await ensureDatabaseExists();

    // 2. Programmatically apply Prisma migrations
    console.log("Prisma: Running database migrations...");
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
    console.log("Migrations applied successfully.");

    // 3. Seed database
    await seedDatabase();

    // 4. Background overdue scanner — run once on boot, then every 6 hours
    const runOverdueScanner = async () => {
      try {
        const now = new Date();
        const overdueOrders = await prisma.rentalOrder.findMany({
          where: {
            status: 'Active',
            expectedReturnDate: { lt: now },
            actualReturnDate: null
          },
          include: { lineItems: true }
        });

        for (const order of overdueOrders) {
          const daysOverdue = Math.max(0, Math.ceil(
            (now.getTime() - new Date(order.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
          ));
          const lateFee = order.lineItems.reduce((sum: number, li: any) => {
            return sum + (Number(li.dailyRate) * 0.10 * daysOverdue * li.rentedQty);
          }, 0);

          await prisma.rentalOrder.update({
            where: { id: order.id },
            data: {
              status: 'Overdue',
              totalLateFeeCalculated: lateFee,
              lateFeeAppliedAt: now,
              overdueAlertSent: true
            }
          });

          // Only write audit once per order (first time flagged)
          if (!order.overdueAlertSent) {
            await prisma.auditLog.create({
              data: {
                companyId: order.companyId,
                username: 'system',
                action: 'ORDER_MARKED_OVERDUE',
                modelName: 'RentalOrder',
                objectId: order.id,
                objectRepr: order.companyOrderNumber,
                additionalInfo: `Order automatically flagged overdue after ${daysOverdue} day(s). Projected fee: ${Math.round(lateFee).toLocaleString()}.`
              }
            });
            await createNotification({
              companyId: order.companyId, category: 'overdue',
              title: `Overdue: Order #${order.companyOrderNumber}`,
              message: `${order.customerName}'s rental is ${daysOverdue} day(s) overdue. Projected late fee: ${Math.round(lateFee).toLocaleString()}.`,
              link: order.companyOrderNumber, dedupe: true,
            });
          }
        }
        if (overdueOrders.length > 0) {
          console.log(`[Overdue Scanner] Flagged ${overdueOrders.length} overdue rental order(s).`);
        }
      } catch (err: any) {
        console.error('[Overdue Scanner] Error:', err.message);
      }
    };

    // Run immediately on boot, then every 6 hours
    await runOverdueScanner();
    setInterval(runOverdueScanner, 6 * 60 * 60 * 1000);

    // 5. Seed Help Guide Center & FAQs
    await seedHelpCenter();

    // 5b. Seed System Health Components
    await seedSystemComponents();

    // 6. Start Express server
    app.listen(PORT, () => {
      console.log(`Server is running successfully on port ${PORT}`);
    });
  } catch (error: any) {
    console.error("Critical error during server boot. Exiting:", error.message);
    process.exit(1);
  }
}

// Help Guide database seeder
async function seedHelpCenter() {
  try {
    const categoryCount = await prisma.helpCategory.count();
    if (categoryCount > 0) return; // already seeded

    console.log('[Seeder] Seeding Help Center guides and FAQs...');

    // 1. Categories
    const billingCat = await prisma.helpCategory.create({
      data: {
        name: 'Billing & Ledgers',
        icon: 'FileText',
        description: 'Invoice processing, payment term settings, client statements, credit limit adjustments, and ledger entries.'
      }
    });

    const dispatchCat = await prisma.helpCategory.create({
      data: {
        name: 'Dispatch Operations',
        icon: 'Truck',
        description: 'Stock check-outs, return operations, serialized fleet assignment, and tracking overdue rentals.'
      }
    });

    const bookingCat = await prisma.helpCategory.create({
      data: {
        name: 'Booking Guides',
        icon: 'CalendarRange',
        description: 'Creating new rental contracts, securing cash deposits, and processing customer order cancellations.'
      }
    });

    const fleetCat = await prisma.helpCategory.create({
      data: {
        name: 'Fleet Maintenance',
        icon: 'Building',
        description: 'Scheduling fleet calibration, recording service logs, writing off damaged tools, and restocking consumables.'
      }
    });

    // 2. Articles
    await prisma.helpArticle.create({
      data: {
        categoryId: billingCat.id,
        title: 'Managing Client Account Statements',
        slug: 'managing-client-statements',
        content: `### Customer ledger & Statements guide
This module explains how to review, manage, and print statement files for customer ledger accounts.

1. **Accessing Ledger Accounts:** Go to the "Customer Ledgers" tab in the left sidebar menu.
2. **Reviewing Transactions:** Click on any client line to view details, credit utilization gauges, and aging buckets (31-60, 61-90, and 90+ days).
3. **Recording Manual Credit/Debit Adjustments:** Click "Post Manual Adjustment", specify transaction type (e.g. discount refund credit), value, and receipt number.
4. **Printing Statements:** Click the print statement icon to view the clean, distraction-free A4 statement format. Press **Ctrl + P** to save as PDF or print.`
      }
    });

    await prisma.helpArticle.create({
      data: {
        categoryId: dispatchCat.id,
        title: 'Handling Overdue Returns & Late Fees',
        slug: 'handling-overdue-returns-fees',
        content: `### Fleet returns & late fee operations guide
Manage active rental returns, mark stock levels back to available, and track overdue items.

1. **Returns Console:** In the "Dispatches & Returns" tab, all active dispatches are visible with red badges if they pass the scheduled return date.
2. **Late Fee Mechanism:** The system applies a daily late fee calculated at **10% of the daily rental rate** multiplied by late days.
3. **Refunding or Adjusting Late Fees:** When returning stock, if the late fee needs waiver, you can post a credit note in the "Credit Notes" tab or use customer ledger offsets.`
      }
    });

    await prisma.helpArticle.create({
      data: {
        categoryId: bookingCat.id,
        title: 'Pre-Event Planning & Equipment Shortages',
        slug: 'pre-event-planning-shortages',
        content: `### Pre-Event logistics scheduling guide
Organize client functions and track equipment availability.

1. **Scheduling events:** Go to "Staff & Scheduling" -> "Event Planner" to add new functions with Client details.
2. **2-Day Availability Scanner:** The dashboard scans booking equipment lines 2 days before the scheduled date.
3. **Shortage Warning Widget:** If items are out on rent, in maintenance, or total bulk inventory is short, a bright red alert warns the team on the dashboard.`
      }
    });

    await prisma.helpArticle.create({
      data: {
        categoryId: fleetCat.id,
        title: 'Tracking Consumables & Calibration Events',
        slug: 'tracking-consumables-calibration',
        content: `### Consumable stock & calibration guide
Manage one-way supplies and track serialized fleet service logs.

1. **Serialized Asset Maintenance:** Select "Items & Assets" -> "Serialized Fleet Assets", select a unit, and click "Maintenance". Logging a servicing event locks the asset status to "Maintenance".
2. **Consumable stock:** Go to the "Consumable Stock" sub-tab to register tape, fuel, paper cups.
3. **Stock Replenishments:** Click "Restock" to log quantity additions, invoice costs, and vendor notes. Keep stock levels above the specified restock threshold.`
      }
    });

    // 3. FAQs
    await prisma.fAQ.createMany({
      data: [
        {
          question: 'How do I print an Account Statement?',
          answer: 'Navigate to the Customer Ledgers tab, search for the client, click "Print Statement" to open the printable layout, then press Ctrl+P or the print button.',
          displayOrder: 1,
          isFeatured: true
        },
        {
          question: 'What happens if consumable stock falls below the restock warning level?',
          answer: 'For consumables, a red warning badge will appear under the Consumable Stock tab to prompt immediate replenishments.',
          displayOrder: 2,
          isFeatured: true
        },
        {
          question: 'How do I assign staff to event roles?',
          answer: 'Go to Staff & Scheduling, find the event, click "Manage Event", select Staff Assignments, choose an employee, and click Assign Role.',
          displayOrder: 3,
          isFeatured: true
        },
        {
          question: 'Are late fees applied automatically?',
          answer: 'Yes! A background worker runs every 6 hours to mark overdue orders and project 10% daily late fees. You can view or adjust them in the returns page.',
          displayOrder: 4,
          isFeatured: true
        }
      ]
    });

    console.log('[Seeder] Help Center seeding complete!');
  } catch (err: any) {
    console.error('Error seeding help center:', err.message);
  }
}

// System health components seeder
async function seedSystemComponents() {
  try {
    const count = await prisma.systemComponent.count();
    if (count > 0) return;

    console.log('[Seeder] Seeding System Health components...');

    await prisma.systemComponent.createMany({
      data: [
        { name: 'API Server', description: 'Express.js REST API backend service handling all business logic endpoints.', status: 'operational' },
        { name: 'Database', description: 'MariaDB/MySQL primary data store powering Prisma ORM queries.', status: 'operational' },
        { name: 'Authentication', description: 'JWT token-based login, session management, and role-based access control.', status: 'operational' },
        { name: 'File Storage', description: 'Local filesystem and static asset serving for uploads and exports.', status: 'operational' },
        { name: 'Email Service', description: 'Outbound transactional email notifications (invoice delivery, password resets).', status: 'operational' },
        { name: 'Background Workers', description: 'Overdue scanner cron, scheduled alerts, and automated fee calculations.', status: 'operational' }
      ]
    });

    console.log('[Seeder] System Health components seeding complete!');
  } catch (err: any) {
    console.error('Error seeding system components:', err.message);
  }
}

startServer();
