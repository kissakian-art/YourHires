import { useState, useEffect, Fragment } from 'react';
import { 
  LayoutDashboard, 
  CalendarRange, 
  Truck, 
  FileText, 
  DollarSign, 
  Settings as SettingsIcon,
  Sun, 
  Moon, 
  Plus, 
  Check, 
  X, 
  Trash2, 
  TrendingUp, 
  AlertTriangle,
  Search,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  Percent,
  ShieldCheck,
  KeyRound,
  Building,
  UserCheck,
  Users,
  ShieldAlert,
  ShieldOff,
  History,
  LogOut,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  Activity,
  Bell,
  Database,
  Download,
  Save,
  Clock,
  RotateCcw,
  LifeBuoy,
  MessageSquare,
  Send,
} from 'lucide-react';
import TaxRatesPanel from './TaxRatesPanel';
import EfrisPanel from './EfrisPanel';
import FiscalInvoice from './FiscalInvoice';
import CatalogTaxModal, { type CatalogTarget } from './CatalogTaxModal';
import {
  fmtMoney, CREDIT_NOTE_REASONS,
  STOCK_IN_TYPES, STOCK_ADJUST_TYPES,
  type Invoice, type CreditNote, type InvoiceLine,
} from './efris-types';
import SearchableUnitSelect from './SearchableUnitSelect';

// Attribute API mutations to the signed-in user for the server-side audit trail.
// The app has no auth-session middleware, so we tag every /api/ request with an
// `x-username` header (the server reads it via getActor). Patching fetch once
// keeps this DRY instead of touching dozens of inline header objects.
let __auditActor = 'system';
let __adminToken = '';
let __sessionToken = '';
let __loggingOut = false;
let __pendingPaymentKey = '';
let __pendingPaymentKeyInvoice: number | null = null;
function setAuditActor(name?: string) { __auditActor = name && name.trim() ? name.trim() : 'system'; }
function setAdminToken(tok?: string) { __adminToken = tok || ''; }
function setSessionToken(tok?: string) { __sessionToken = tok || ''; }
if (typeof window !== 'undefined' && !(window as any).__yhFetchPatched) {
  const _origFetch = window.fetch.bind(window);
  window.fetch = (input: any, init: any = {}) => {
    if (typeof input === 'string' && input.includes('/api/')) {
      const headers: any = { ...(init.headers || {}), 'x-username': __auditActor };
      // Per-user session token — authoritative identity for the server.
      if (__sessionToken) headers['x-session-token'] = __sessionToken;
      // Attach the platform-admin bearer token only to super-admin endpoints.
      if (input.includes('/api/admin/') && __adminToken) headers['x-admin-token'] = __adminToken;
      init = { ...init, headers };
      const isAuthCall = input.includes('/api/auth/');
      const p = _origFetch(input, init);
      // Auto sign-out when the session has expired (server returns 401) — except
      // for the auth endpoints themselves (login returns 401 on bad credentials).
      if (!isAuthCall) {
        return p.then((res: Response) => {
          // Only auto-logout on 401 when we actually HAVE a session (logged in and
          // it expired). A logged-OUT visitor's initial dashboard calls also 401,
          // and reloading there would loop forever (nothing in localStorage to
          // clear to break it), hammering the server until it 429s. Guarding on
          // __sessionToken shows the login screen instead.
          if (res.status === 401 && !__loggingOut && __sessionToken) {
            __loggingOut = true;
            try { localStorage.removeItem('yourhires_user'); } catch { /* noop */ }
            window.location.reload();
          }
          return res;
        });
      }
      return p;
    }
    return _origFetch(input, init);
  };
  (window as any).__yhFetchPatched = true;
}

// The Settings index. Grouped the way a business thinks about them rather than
// the order they were built in, so the page reads as a map instead of a pile.
const SETTINGS_GROUPS: {
  group: string;
  items: { key: string; title: string; description: string; icon: any }[];
}[] = [
  {
    group: 'Business',
    items: [
      { key: 'business', title: 'Business Settings', description: 'Currency, payment terms, and the return & reconciliation fee policy.', icon: Building },
      { key: 'notifications', title: 'Notifications & Audit Log', description: 'Choose which alerts reach your bell, and review the system audit trail.', icon: Bell },
    ],
  },
  {
    group: 'Finance & Compliance',
    items: [
      { key: 'tax', title: 'Tax Rates', description: 'The rates this business charges and the URA category each is reported under.', icon: Percent },
      { key: 'efris', title: 'URA EFRIS', description: 'Fiscalize invoices with URA, register your catalogue, and report stock.', icon: ShieldCheck },
    ],
  },
  {
    group: 'Users & Security',
    items: [
      { key: 'team', title: 'Team & Access', description: 'Manage who can sign in and what each person is allowed to do.', icon: Users },
      { key: 'roles', title: 'Roles & Permissions', description: 'Define roles and the permission matrix behind them.', icon: ShieldAlert },
    ],
  },
  {
    group: 'System',
    items: [
      { key: 'backup', title: 'Database Backup & Restore', description: 'Run and schedule backups, and restore from an earlier one.', icon: Database },
      { key: 'license', title: 'Desktop License', description: 'Machine fingerprint and license key for this installation.', icon: KeyRound },
    ],
  },
];

// True when running inside the packaged Tauri desktop app (vs the web/SaaS build).
// Used to hide SaaS-only copy (free-trial marketing) that doesn't apply to an
// installed, licensed desktop deployment.
const IS_DESKTOP = typeof window !== 'undefined' &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__ || !!(window as any).isTauri);

// Interfaces for UI state
interface AuditLog {
  id: number;
  companyId: number;
  username: string;
  action: string;
  modelName: string;
  objectId?: number;
  objectRepr: string;
  additionalInfo?: string;
  createdAt: string;
}

interface Company {
  id: number;
  name: string;
  publicSlug: string;
  currency?: string;
  currencySymbol?: string;
  country?: string;
  timezone?: string;
  industry?: string;
  trialActive?: boolean;
  trialEndsAt?: string;
  trialDaysLeft?: number;
  onboardingComplete?: boolean;
}

interface Item {
  id: number;
  name: string;
  category: string;
  dailyRentalRate: number;
  replacementCost: number;
  currentStock: number;
  unitOfMeasure?: string;
  unitCost?: number;
}

interface BookingLineItem {
  id: number;
  itemId: number;
  quantity: number;
  dailyRate: number;
  estimatedRentalDays: number;
}

interface Booking {
  id: number;
  bookingNumber: string;
  customerName: string;
  contactInfo: string;
  bookingType: 'customer' | 'function';
  scheduledPickupDate: string;
  scheduledReturnDate: string;
  estimatedTotalCost: number;
  depositAmount: number;
  depositPaid: boolean;
  depositPaidDate?: string;
  status: 'pending' | 'confirmed' | 'converted' | 'cancelled' | 'expired';
  lineItems: BookingLineItem[];
}

interface SubscriptionPlan {
  id: number;
  name: string;
  planType: string;
  priceMonthly: number;
  maxUsers?: number;
  maxItems?: number;
}

interface RentalLineItem {
  id: number;
  itemType: 'item' | 'asset' | 'consumable';
  itemId?: number | null;
  assetId?: number | null;
  quantity: number;
  rentedQty: number;
  returnedQty: number;
  damagedQty: number;
  lostQty: number;
  dailyRate: number;
  item?: { id: number; name: string; unitReplacementCost: number } | null;
  asset?: { id: number; name: string; serialNumber: string; replacementCost: number } | null;
}

interface RentalOrder {
  id: number;
  companyOrderNumber: string;
  customerName: string;
  checkoutDate: string;
  expectedReturnDate: string;
  actualReturnDate?: string;
  status: 'Active' | 'Returned' | 'Finalized' | 'Overdue' | 'Partially Returned';
  totalLateFeeCalculated: number;
  totalReplacementFeeCalculated: number;
  totalAmountPaid: number;
  estimatedTotal: number;
  isFullyReconciled?: boolean;
  lineItems?: RentalLineItem[];
}

// Invoice and CreditNote now live in efris-types.ts — they carry line items, a
// tax breakdown and the URA fiscal fields, and are shared with the panels.

interface Customer {
  id: number;
  name: string;
  contactInfo: string;
  isOnWatchList: boolean;
  watchListReason?: string;
  _count?: { rentalOrders: number; bookings: number };
}

// Lightweight canvas signature pad — mouse + touch, no external library.
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasStroke, setHasStroke] = useState(false);

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    setIsDrawing(true);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1e293b';
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasStroke(true);
  };
  const end = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setIsDrawing(false);
    if (hasStroke) onChange(e.currentTarget.toDataURL('image/png'));
  };
  const clear = () => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    setHasStroke(false);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <canvas
        ref={setCanvas}
        width={400}
        height={150}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={e => isDrawing && end(e)}
        className="w-full bg-white rounded-xl border border-slate-200/30 cursor-crosshair touch-none"
      />
      <button onClick={clear} type="button" className="text-[10px] font-bold text-slate-500 hover:text-slate-700 cursor-pointer">Clear signature</button>
    </div>
  );
}

// Inline row for adding an item/asset to a function template.
function TemplateItemAdder({ items, assets, onAdd }: { items: any[]; assets: any[]; onAdd: (itemType: string, refId: string, qty: string) => void }) {
  const [itemType, setItemType] = useState('item');
  const [refId, setRefId] = useState('');
  const [qty, setQty] = useState('1');
  const options = itemType === 'item' ? items : assets;

  return (
    <div className="flex items-center space-x-1.5 pt-1">
      <select value={itemType} onChange={e => { setItemType(e.target.value); setRefId(''); }}
        className="bg-neo shadow-neo-inset-sm border-none px-2 py-1.5 rounded-lg text-[10px] text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer">
        <option value="item">Item</option>
        <option value="asset">Asset</option>
      </select>
      <select value={refId} onChange={e => setRefId(e.target.value)}
        className="flex-1 bg-neo shadow-neo-inset-sm border-none px-2 py-1.5 rounded-lg text-[10px] text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer">
        <option value="">-- Select --</option>
        {options.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)}
        className="w-14 bg-neo shadow-neo-inset-sm border-none px-2 py-1.5 rounded-lg text-[10px] text-center text-slate-800 dark:text-slate-200 focus:outline-none" />
      <button
        onClick={() => { onAdd(itemType, refId, qty); setRefId(''); setQty('1'); }}
        className="px-2.5 py-1.5 bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink cursor-pointer"
      >
        Add
      </button>
    </div>
  );
}

// Inline form to spin up a real function from a template, filling in event-specific details.
function CreateFromTemplateForm({ defaults, onSubmit }: { defaults: { location?: string; time?: string }; onSubmit: (form: { name: string; date: string; clientName: string; clientContact: string; location?: string; time?: string }) => void }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientContact, setClientContact] = useState('');
  const [location, setLocation] = useState(defaults.location || '');
  const [time, setTime] = useState(defaults.time || '');

  return (
    <div className="bg-neo shadow-neo-outset-sm rounded-xl p-3 space-y-2 border border-blue-500/10">
      <p className="text-[10px] uppercase font-black text-slate-500">New Event From Template</p>
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="Event name" value={name} onChange={e => setName(e.target.value)} className="bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none" />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none" />
        <input placeholder="Client name" value={clientName} onChange={e => setClientName(e.target.value)} className="bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none" />
        <input placeholder="Client contact" value={clientContact} onChange={e => setClientContact(e.target.value)} className="bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none" />
        <input placeholder="Location" value={location} onChange={e => setLocation(e.target.value)} className="bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none" />
        <input placeholder="Time (e.g. 09:00)" value={time} onChange={e => setTime(e.target.value)} className="bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none" />
      </div>
      <button
        onClick={() => {
          if (!name || !date || !clientName) return alert('Event name, date, and client name are required.');
          onSubmit({ name, date, clientName, clientContact, location, time });
        }}
        className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg active-shrink cursor-pointer"
      >
        Create Event
      </button>
    </div>
  );
}

function App() {
  // Theme state
  const [isDarkMode, setIsDarkMode] = useState(() => {
    return localStorage.getItem('theme') === 'dark' || 
      (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });

  // Active navigation tab
  const [activeTab, setActiveTab] = useState<'dashboard' | 'bookings' | 'dispatches' | 'invoices' | 'creditNotes' | 'inventory' | 'customers' | 'scheduling' | 'bookkeeping' | 'settings' | 'ledgers' | 'revenue' | 'help' | 'health'>('dashboard');

  // Same-origin in the hosted web build (VITE_API_URL is injected at build time,
  // e.g. https://hires.midwayug.com). Dev and the desktop Tauri build leave it
  // unset and fall back to the local dev server.
  const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:20090';

  // Routing helper
  const getPublicSlugFromUrl = () => {
    const path = window.location.pathname;
    const match = path.match(/^\/public\/([a-zA-Z0-9\-]+)/);
    return match ? match[1] : null;
  };

  // Public Catalog Storefront states
  const [publicCompany, setPublicCompany] = useState<any>(null);
  const [publicItems, setPublicItems] = useState<any[]>([]);
  const [publicCatalogLoading, setPublicCatalogLoading] = useState(true);
  const [publicCatalogError, setPublicCatalogError] = useState('');
  
  // Public Cart State
  const [publicCart, setPublicCart] = useState<{ [itemId: number]: number }>({});
  const [publicCustomerName, setPublicCustomerName] = useState('');
  const [publicContactInfo, setPublicContactInfo] = useState('');
  const [publicPickupDate, setPublicPickupDate] = useState('');
  const [publicReturnDate, setPublicReturnDate] = useState('');
  const [publicBookingSuccess, setPublicBookingSuccess] = useState<any>(null);
  const [submittingPublicBooking, setSubmittingPublicBooking] = useState(false);

  // Fetch public catalog on mount if path matches
  useEffect(() => {
    const slug = getPublicSlugFromUrl();
    if (slug) {
      fetch(`${API_URL}/api/public/${slug}/catalog`)
        .then(res => {
          if (!res.ok) throw new Error('Catalog not found or bookings disabled.');
          return res.json();
        })
        .then(data => {
          setPublicCompany(data.company);
          setPublicItems(data.items);
          setPublicCatalogLoading(false);
        })
        .catch(err => {
          setPublicCatalogError(err.message);
          setPublicCatalogLoading(false);
        });
    }
  }, []);

  const handlePublicBookingSubmit = async () => {
    const slug = getPublicSlugFromUrl();
    const cartEntries = Object.entries(publicCart).filter(([_, qty]) => qty > 0);
    if (!publicCustomerName || cartEntries.length === 0) {
      alert("Please specify your name and select at least one catalog item.");
      return;
    }
    setSubmittingPublicBooking(true);
    try {
      const lineItems = cartEntries.map(([itemId, qty]) => ({
        itemId: parseInt(itemId),
        quantity: qty
      }));

      const res = await fetch(`${API_URL}/api/public/${slug}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: publicCustomerName,
          contactInfo: publicContactInfo,
          bookingType: 'pickup',
          scheduledPickupDate: publicPickupDate || undefined,
          scheduledReturnDate: publicReturnDate || undefined,
          lineItems
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to submit booking request.');
      }

      const data = await res.json();
      setPublicBookingSuccess(data);
      setPublicCart({});
      setPublicCustomerName('');
      setPublicContactInfo('');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSubmittingPublicBooking(false);
    }
  };

  // User Authentication State
  const [currentUser, setCurrentUser] = useState<any>(() => {
    const saved = localStorage.getItem('yourhires_user');
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    // Seed the auth tokens synchronously at mount so the first data load is authenticated.
    setSessionToken(parsed?.sessionToken);
    setAdminToken(parsed?.adminToken);
    setAuditActor(parsed?.user?.username);
    return parsed;
  });

  // Keep the audit actor, session token, and platform-admin token in sync.
  useEffect(() => {
    setAuditActor(currentUser?.user?.username);
    setAdminToken(currentUser?.adminToken);
    setSessionToken(currentUser?.sessionToken);
  }, [currentUser]);

  // Business-permission check for UI gating. System admins (and superusers) always
  // pass; other users are checked against their role's permission matrix from login.
  const can = (moduleKey: string, action: string): boolean => {
    const u = currentUser?.user;
    if (!u) return false;
    if (u.isSuperuser || u.isSystemAdmin || u.role === 'Admin') return true;
    // Backward-compat: a session persisted before RBAC has no permission matrix —
    // approximate the old Staff behavior so it doesn't lock the user out.
    if (!u.permissions) {
      if (['revenue', 'purchases', 'settings', 'team', 'ledgers', 'invoices', 'creditNotes'].includes(moduleKey)) return false;
      return action !== 'delete';
    }
    return !!(u.permissions[moduleKey] && u.permissions[moduleKey][action]);
  };

  // Fetch desktop license status on mount (drives the block screen / trial banner).
  useEffect(() => {
    fetch(`${API_URL}/api/license/status`).then(r => (r.ok ? r.json() : null)).then(d => { if (d) setLicenseStatus(d); }).catch(() => {});
  }, []);

  // Business Context State
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number>(() => {
    const saved = localStorage.getItem('yourhires_user');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.company) return parsed.company.id;
    }
    return 1;
  });
  const activeCompany = companies.find(c => c.id === selectedCompanyId) || { id: selectedCompanyId, name: currentUser?.company?.name || "Mega Rentals Uganda Ltd", publicSlug: currentUser?.company?.publicSlug || "mega-rentals", currency: (currentUser?.company as any)?.currency || 'UGX' };

  // Login Input States
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Sign-Up Wizard States
  const [showSignup, setShowSignup] = useState(false);
  // Password reset / forgot flow
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMsg, setForgotMsg] = useState('');
  const [resetToken, setResetToken] = useState<string | null>(() => new URLSearchParams(window.location.search).get('resetToken'));
  const [resetPassword, setResetPassword] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [signupStep, setSignupStep] = useState(1);
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupError, setSignupError] = useState('');
  const [welcomeToast, setWelcomeToast] = useState('');
  // Step 1: Org Info
  const [su_companyName, setSu_companyName] = useState('');
  const [su_industry, setSu_industry] = useState('Equipment Rental');
  const [su_address, setSu_address] = useState('');
  const [su_phone, setSu_phone] = useState('');
  // Step 2: Locale
  const [su_country, setSu_country] = useState('UG');
  const [su_currency, setSu_currency] = useState('UGX');
  const [su_currencySymbol, setSu_currencySymbol] = useState('UGX');
  const [su_timezone, setSu_timezone] = useState('Africa/Kampala');
  // Step 3: Admin Account
  const [su_firstName, setSu_firstName] = useState('');
  const [su_lastName, setSu_lastName] = useState('');
  const [su_email, setSu_email] = useState('');
  const [su_username, setSu_username] = useState('');
  const [su_password, setSu_password] = useState('');
  const [su_confirmPassword, setSu_confirmPassword] = useState('');
  const [su_usernameStatus, setSu_usernameStatus] = useState<'idle'|'checking'|'available'|'taken'>('idle');

  // Country → Currency + Timezone mapping
  const COUNTRY_MAP: Record<string, { currency: string; symbol: string; timezone: string; name: string }> = {
    UG: { currency: 'UGX', symbol: 'UGX', timezone: 'Africa/Kampala', name: 'Uganda' },
    KE: { currency: 'KES', symbol: 'KSh', timezone: 'Africa/Nairobi', name: 'Kenya' },
    TZ: { currency: 'TZS', symbol: 'TSh', timezone: 'Africa/Dar_es_Salaam', name: 'Tanzania' },
    RW: { currency: 'RWF', symbol: 'RWF', timezone: 'Africa/Kigali', name: 'Rwanda' },
    NG: { currency: 'NGN', symbol: '₦', timezone: 'Africa/Lagos', name: 'Nigeria' },
    GH: { currency: 'GHS', symbol: 'GH₵', timezone: 'Africa/Accra', name: 'Ghana' },
    ZA: { currency: 'ZAR', symbol: 'R', timezone: 'Africa/Johannesburg', name: 'South Africa' },
    EG: { currency: 'EGP', symbol: 'E£', timezone: 'Africa/Cairo', name: 'Egypt' },
    ET: { currency: 'ETB', symbol: 'Br', timezone: 'Africa/Addis_Ababa', name: 'Ethiopia' },
    US: { currency: 'USD', symbol: '$', timezone: 'America/New_York', name: 'United States' },
    GB: { currency: 'GBP', symbol: '£', timezone: 'Europe/London', name: 'United Kingdom' },
    EU: { currency: 'EUR', symbol: '€', timezone: 'Europe/Berlin', name: 'European Union' },
    AE: { currency: 'AED', symbol: 'د.إ', timezone: 'Asia/Dubai', name: 'United Arab Emirates' },
    IN: { currency: 'INR', symbol: '₹', timezone: 'Asia/Kolkata', name: 'India' },
    AU: { currency: 'AUD', symbol: 'A$', timezone: 'Australia/Sydney', name: 'Australia' },
    CA: { currency: 'CAD', symbol: 'C$', timezone: 'America/Toronto', name: 'Canada' },
    ZM: { currency: 'ZMW', symbol: 'ZK', timezone: 'Africa/Lusaka', name: 'Zambia' },
    ZW: { currency: 'ZWL', symbol: 'Z$', timezone: 'Africa/Harare', name: 'Zimbabwe' },
    MZ: { currency: 'MZN', symbol: 'MT', timezone: 'Africa/Maputo', name: 'Mozambique' },
    MW: { currency: 'MWK', symbol: 'MK', timezone: 'Africa/Blantyre', name: 'Malawi' },
  };

  const getPasswordStrength = (p: string): { score: number; label: string; color: string } => {
    let score = 0;
    if (p.length >= 8) score++;
    if (p.length >= 12) score++;
    if (/[A-Z]/.test(p)) score++;
    if (/[0-9]/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;
    if (score <= 1) return { score, label: 'Weak', color: 'bg-red-500' };
    if (score <= 2) return { score, label: 'Fair', color: 'bg-amber-500' };
    if (score <= 3) return { score, label: 'Good', color: 'bg-blue-500' };
    return { score, label: 'Strong', color: 'bg-green-500' };
  };

  // Debounced username availability check
  useEffect(() => {
    if (!su_username || su_username.length < 3) { setSu_usernameStatus('idle'); return; }
    setSu_usernameStatus('checking');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/check-username?username=${encodeURIComponent(su_username)}`);
        const data = await res.json();
        setSu_usernameStatus(data.available ? 'available' : 'taken');
      } catch { setSu_usernameStatus('idle'); }
    }, 500);
    return () => clearTimeout(t);
  }, [su_username]);

  const handleCountryChange = (code: string) => {
    setSu_country(code);
    const info = COUNTRY_MAP[code];
    if (info) {
      setSu_currency(info.currency);
      setSu_currencySymbol(info.symbol);
      setSu_timezone(info.timezone);
    }
  };

  const handleRegister = async () => {
    if (!su_companyName.trim()) { setSignupError('Company name is required.'); return; }
    if (!su_firstName.trim() || !su_lastName.trim()) { setSignupError('First and last name are required.'); return; }
    if (!su_email.trim() || !su_email.includes('@')) { setSignupError('A valid email address is required.'); return; }
    if (!su_username.trim() || su_username.length < 3) { setSignupError('Username must be at least 3 characters.'); return; }
    if (su_usernameStatus === 'taken') { setSignupError('That username is already taken. Please choose another.'); return; }
    if (su_password.length < 8) { setSignupError('Password must be at least 8 characters.'); return; }
    if (su_password !== su_confirmPassword) { setSignupError('Passwords do not match.'); return; }
    setSignupError('');
    setSignupLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: su_companyName,
          industry: su_industry,
          address: su_address,
          phone: su_phone,
          country: su_country,
          currency: su_currency,
          currencySymbol: su_currencySymbol,
          timezone: su_timezone,
          firstName: su_firstName,
          lastName: su_lastName,
          email: su_email,
          username: su_username,
          password: su_password,
        })
      });
      const data = await res.json();
      if (!res.ok) { setSignupError(data.error || 'Registration failed.'); return; }
      // Auto-login
      setSessionToken(data.sessionToken);
      setCurrentUser(data);
      if (data.company) setSelectedCompanyId(data.company.id);
      localStorage.setItem('yourhires_user', JSON.stringify(data));
      setShowSignup(false);
      setWelcomeToast(`🎉 Welcome, ${data.user.firstName}! Your 30-day free trial has started.`);
      setTimeout(() => setWelcomeToast(''), 6000);
    } catch (err: any) {
      setSignupError(err.message);
    } finally {
      setSignupLoading(false);
    }
  };

  // Database / Store States loaded from server
  const [items, setItems] = useState<Item[]>([]);
  const [assets, setAssets] = useState<any[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [rentalOrders, setRentalOrders] = useState<RentalOrder[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  // Database backup & restore
  type BackupFile = { name: string; size: number; createdAt: string; kind: string };
  type BackupState = {
    config: { enabled: boolean; hour: number; retention: number; dir: string };
    backups: BackupFile[];
    lastBackup: BackupFile | null;
  };
  const [backupInfo, setBackupInfo] = useState<BackupState | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);

  // Desktop licensing (only active when the server enforces it; a no-op for web/dev)
  type LicenseStatus = {
    enforced: boolean; state: string; blocked: boolean; fingerprint: string;
    daysLeft: number | null; expiresAt: string | null; plan: string | null;
    licensee: string | null; message: string;
  };
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [activatingLicense, setActivatingLicense] = useState(false);

  // Super-admin (platform) console
  const [adminMetrics, setAdminMetrics] = useState<any>(null);
  const [adminCompanies, setAdminCompanies] = useState<any[]>([]);
  const [adminGenFp, setAdminGenFp] = useState('');
  const [adminGenDays, setAdminGenDays] = useState('365');
  const [adminGenLicensee, setAdminGenLicensee] = useState('');
  const [adminGenKey, setAdminGenKey] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);

  // Document printing states
  const [activeInvoiceToPrint, setActiveInvoiceToPrint] = useState<Invoice | null>(null);
  const [activeBookingToPrint, setActiveBookingToPrint] = useState<Booking | null>(null);

  // Customer module state
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustContact, setNewCustContact] = useState('');
  const [custSearch, setCustSearch] = useState('');
  const [watchlistFilter, setWatchlistFilter] = useState<'all' | 'watchlisted' | 'clear'>('all');
  const [customerHistoryId, setCustomerHistoryId] = useState<number | null>(null);
  const [customerHistory, setCustomerHistory] = useState<any>(null);
  const [agingReport, setAgingReport] = useState({
    current: 0,
    overdue1to30: 0,
    overdue31to60: 0,
    overdue61to90: 0,
    overdue90Plus: 0,
    totalUnpaid: 0
  });

  // Customer Account Balance & Ledger System States
  const [customerAccounts, setCustomerAccounts] = useState<any[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [selectedAccountDetails, setSelectedAccountDetails] = useState<any | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showManualAdjustmentModal, setShowManualAdjustmentModal] = useState(false);
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [recalculatingAccounts, setRecalculatingAccounts] = useState(false);

  // Manual transaction form
  const [adjType, setAdjType] = useState<'invoice' | 'payment' | 'credit_memo' | 'adjustment' | 'refund' | 'late_fee' | 'damage_fee'>('adjustment');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjDescription, setAdjDescription] = useState('');
  const [adjReference, setAdjReference] = useState('');
  const [adjDueDate, setAdjDueDate] = useState('');

  // Account settings edit form
  const [editingSettings, setEditingSettings] = useState(false);
  const [editCreditLimit, setEditCreditLimit] = useState('');
  const [editPaymentTerms, setEditPaymentTerms] = useState('');

  // Statement print view
  const [activeStatementToPrint, setActiveStatementToPrint] = useState<any | null>(null);

  // 🔧 Asset Maintenance States
  const [selectedAssetForMaintenance, setSelectedAssetForMaintenance] = useState<any | null>(null);
  const [maintenanceEvents, setMaintenanceEvents] = useState<any[]>([]);
  const [showMaintenanceModal, setShowMaintenanceModal] = useState(false);
  const [maintTitle, setMaintTitle] = useState('');
  const [maintDescription, setMaintDescription] = useState('');
  const [maintStartTime, setMaintStartTime] = useState('');
  const [maintEndTime, setMaintEndTime] = useState('');
  const [maintStatus, setMaintStatus] = useState('Scheduled');
  const [maintCost, setMaintCost] = useState('');
  const [maintNotes, setMaintNotes] = useState('');

  // 📅 Event Reservations Cockpit States (Function Details Drawer)
  const [selectedFunctionEvent, setSelectedFunctionEvent] = useState<any | null>(null);
  const [showFunctionDrawer, setShowFunctionDrawer] = useState(false);
  const [activeFunctionTab, setActiveFunctionTab] = useState<'staffing' | 'equipment' | 'checklist' | 'issues' | 'timeline' | 'financials'>('staffing');
  const [functionItems, setFunctionItems] = useState<any[]>([]);
  const [functionChecklist, setFunctionChecklist] = useState<any[]>([]);
  const [functionIssues, setFunctionIssues] = useState<any[]>([]);
  const [functionActivities, setFunctionActivities] = useState<any[]>([]);
  const [functionExpenses, setFunctionExpenses] = useState<any[]>([]);
  const [functionSignatures, setFunctionSignatures] = useState<any[]>([]);
  const [fxExpType, setFxExpType] = useState('other');
  const [fxExpDesc, setFxExpDesc] = useState('');
  const [fxExpAmt, setFxExpAmt] = useState('');
  const [fxExpDate, setFxExpDate] = useState('');
  const [fxExpReceipt, setFxExpReceipt] = useState('');
  const [newRevAmount, setNewRevAmount] = useState('');
  const [newRevMethod, setNewRevMethod] = useState('cash');
  const [newRevRef, setNewRevRef] = useState('');
  const [newRevNotes, setNewRevNotes] = useState('');
  const [showCompleteFunctionModal, setShowCompleteFunctionModal] = useState(false);
  const [completionNotesInput, setCompletionNotesInput] = useState('');
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [signatureType, setSignatureType] = useState('function');
  const [signeeName, setSigneeName] = useState('');
  const [signeeContact, setSigneeContact] = useState('');
  // Function templates
  const [functionTemplates, setFunctionTemplates] = useState<any[]>([]);
  const [showTemplatesModal, setShowTemplatesModal] = useState(false);
  const [showCreateTemplateModal, setShowCreateTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateDesc, setNewTemplateDesc] = useState('');
  const [createFromTemplateId, setCreateFromTemplateId] = useState<number | null>(null);

  // Reservation Form
  const [reserveType, setReserveType] = useState<'item' | 'asset' | 'consumable'>('item');
  const [reserveItemId, setReserveItemId] = useState('');
  const [reserveAssetId, setReserveAssetId] = useState('');
  const [reserveConsumableId, setReserveConsumableId] = useState('');
  const [reserveUomId, setReserveUomId] = useState('');
  const [reserveQuantity, setReserveQuantity] = useState('1');
  const [reserveNotes, setReserveNotes] = useState('');

  // Checklist Form
  const [newChecklistText, setNewChecklistText] = useState('');
  const [checklistAssigneeId, setChecklistAssigneeId] = useState('');

  // Issue Form
  const [newIssueTitle, setNewIssueTitle] = useState('');
  const [newIssueDescription, setNewIssueDescription] = useState('');
  const [newIssueSeverity, setNewIssueSeverity] = useState<'Low' | 'Medium' | 'High' | 'Critical'>('Medium');

  // Activity Form
  const [newTimelineDescription, setNewTimelineDescription] = useState('');

  // ⚠️ 2-Day Pre-Event Availability Alerts State
  const [functionAlerts, setFunctionAlerts] = useState<any[]>([]);

  // 💵 Consolidated Revenue Ledger States
  const [incomeRecords, setIncomeRecords] = useState<any[]>([]);
  const [incomeAnalytics, setIncomeAnalytics] = useState<any | null>(null);
  const [showManualIncomeModal, setShowManualIncomeModal] = useState(false);
  const [revenueSearch, setRevenueSearch] = useState('');
  const [revenueSourceFilter, setRevenueSourceFilter] = useState('');
  const [revenueMethodFilter, setRevenueMethodFilter] = useState('');
  const [revenueStartDate, setRevenueStartDate] = useState('');
  const [revenueEndDate, setRevenueEndDate] = useState('');
  const [revenueCategoryFilter, setRevenueCategoryFilter] = useState('');
  const [revenueCustomerFilter, setRevenueCustomerFilter] = useState('');

  // Manual Income Form
  const [newIncAmount, setNewIncAmount] = useState('');
  const [newIncMethod, setNewIncMethod] = useState('cash');
  const [newIncReference, setNewIncReference] = useState('');
  const [newIncDescription, setNewIncDescription] = useState('');

  // 📦 Consumable Stock States
  const [consumables, setConsumables] = useState<any[]>([]);
  const [selectedConsumable, setSelectedConsumable] = useState<any | null>(null);
  const [consumableLogs, setConsumableLogs] = useState<any[]>([]);
  const [consSubTab, setConsSubTab] = useState<'rentals' | 'assets' | 'consumables'>('rentals');

  // Modals visibility
  const [showConsumableModal, setShowConsumableModal] = useState(false);
  const [showConsumableUseModal, setShowConsumableUseModal] = useState(false);
  const [showConsumableRestockModal, setShowConsumableRestockModal] = useState(false);
  const [showConsumableLogsModal, setShowConsumableLogsModal] = useState(false);

  // Creation Form
  const [consName, setConsName] = useState('');
  const [consCategory, setConsCategory] = useState('general');
  const [consStockQty, setConsStockQty] = useState('');
  const [consRestockLevel, setConsRestockLevel] = useState('');
  const [consUnitPrice, setConsUnitPrice] = useState('');
  const [consCostPrice, setConsCostPrice] = useState('');
  const [consSku, setConsSku] = useState('');

  // Global UoM and Scaling Form fields
  const [uoms, setUoms] = useState<any[]>([]);
  const [consIsMultiUnit, setConsIsMultiUnit] = useState(false);
  const [consPackageUnitId, setConsPackageUnitId] = useState<number | ''>('');
  const [consPieceUnitId, setConsPieceUnitId] = useState<number | ''>('');
  const [consUnitRatio, setConsUnitRatio] = useState<number>(1);
  const [consPackagePrice, setConsPackagePrice] = useState('');
  const [consUnitOfMeasureId, setConsUnitOfMeasureId] = useState<number | ''>('');

  // Use / Restock forms
  const [consUseQty, setConsUseQty] = useState('');
  const [consUseNotes, setConsUseNotes] = useState('');
  const [consRestockQty, setConsRestockQty] = useState('');
  const [consRestockCost, setConsRestockCost] = useState('');
  const [consRestockNotes, setConsRestockNotes] = useState('');

  // ❓ Help Center / Knowledge Database States
  const [helpCategories, setHelpCategories] = useState<any[]>([]);
  const [helpArticles, setHelpArticles] = useState<any[]>([]);
  const [helpFaqs, setHelpFaqs] = useState<any[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<any | null>(null);
  const [helpSearch, setHelpSearch] = useState('');
  const [selectedHelpCategory, setSelectedHelpCategory] = useState<number | null>(null);
  const [expandedFaqId, setExpandedFaqId] = useState<number | null>(null);

  // 🛟 Midway Support Desk — in-app tickets filed to the central Midway desk.
  // The whole block stays hidden unless the server reports a configured channel key.
  const [supportConfigured, setSupportConfigured] = useState(false);
  const [supportTickets, setSupportTickets] = useState<any[]>([]);
  const [supportKbResults, setSupportKbResults] = useState<any[] | null>(null);
  const [supportKbQuery, setSupportKbQuery] = useState('');
  const [supportSubject, setSupportSubject] = useState('');
  const [supportDescription, setSupportDescription] = useState('');
  const [supportPriority, setSupportPriority] = useState('NORMAL');
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const [supportNotice, setSupportNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [supportOpenRef, setSupportOpenRef] = useState<string | null>(null);
  const [supportThread, setSupportThread] = useState<any | null>(null);
  const [supportThreadLoading, setSupportThreadLoading] = useState(false);
  const [supportReply, setSupportReply] = useState('');

  // 🖥️ System Health / Incidents Board States
  const [systemComponents, setSystemComponents] = useState<any[]>([]);
  const [systemIncidents, setSystemIncidents] = useState<any[]>([]);
  const [showIncidentModal, setShowIncidentModal] = useState(false);
  const [incidentComponentId, setIncidentComponentId] = useState('');
  const [incidentTitle, setIncidentTitle] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState('info');
  const [incidentMessage, setIncidentMessage] = useState('');
  const [selectedSystemComponent, setSelectedSystemComponent] = useState<number | null>(null);

  // Analytics Filter States
  const [analyticsStartDate, setAnalyticsStartDate] = useState('');
  const [analyticsEndDate, setAnalyticsEndDate] = useState('');
  const [analyticsCategory, setAnalyticsCategory] = useState('All');
  const [analyticsCustomer, setAnalyticsCustomer] = useState('');

  // Dynamic Dashboard Stats State
  const [dashboardStats, setDashboardStats] = useState({
    activeRentalIncome: 0,
    depositsCollected: 0,
    outstandingInvoices: 0,
    assetUtilization: 0,
    utilizationChart: [] as Array<{ name: string, percent: number, rented: number, stock: number, category: string }>
  });

  // Overdue Alerts State
  const [overdueAlerts, setOverdueAlerts] = useState<{
    overdueCount: number;
    totalProjectedFees: number;
    orders: Array<{ id: number; companyOrderNumber: string; customerName: string; expectedReturnDate: string; daysOverdue: number; projectedLateFee: number; }>;
  }>({ overdueCount: 0, totalProjectedFees: 0, orders: [] });
  const [applyingLateFee, setApplyingLateFee] = useState<number | null>(null);
  // Return reconciliation modal state
  const [returnOrder, setReturnOrder] = useState<RentalOrder | null>(null);
  const [returnLines, setReturnLines] = useState<Record<number, { returned: number; damaged: number; lost: number }>>({});
  const [returnNotes, setReturnNotes] = useState('');
  const [processingReturn, setProcessingReturn] = useState(false);
  // Business settings form (fee policy) — persisted via PATCH /api/companies/:id/settings
  const [bizSettings, setBizSettings] = useState({
    currency: 'UGX', defaultPaymentTermsDays: 30,
    lateFeePercentPerDay: 10, damageFeePercent: 50, lostFeePercent: 100, restockReturnedItems: true,
    pricesIncludeTax: true
  });
  // URA EFRIS: whether the fiscalize actions should appear at all.
  const [efrisConfig, setEfrisConfig] = useState<{ enabled: boolean; configured: boolean; tin: string | null; feeItemRegistered: boolean }>(
    { enabled: false, configured: false, tin: null, feeItemRegistered: false }
  );
  const [fiscalizingId, setFiscalizingId] = useState<number | null>(null);
  const [fiscalInvoice, setFiscalInvoice] = useState<Invoice | null>(null);
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<number | null>(null);
  // Credit-memo dialog: URA wants a reason code, not just free text.
  const [creditMemoInvoice, setCreditMemoInvoice] = useState<Invoice | null>(null);
  const [creditMemoReason, setCreditMemoReason] = useState('');
  const [creditMemoCode, setCreditMemoCode] = useState('101');
  const [issuingCreditMemo, setIssuingCreditMemo] = useState(false);
  // Tax and URA details for one catalogue entry, edited in its own dialog.
  const [taxTarget, setTaxTarget] = useState<CatalogTarget | null>(null);
  const [taxRatesList, setTaxRatesList] = useState<any[]>([]);
  // URA stock reporting alongside a local consumable movement (T131).
  const [consRestockToUra, setConsRestockToUra] = useState(false);
  const [consRestockUraType, setConsRestockUraType] = useState('102');
  const [consRestockSupplier, setConsRestockSupplier] = useState('');
  const [consRestockSupplierTin, setConsRestockSupplierTin] = useState('');
  const [consRestockBatchNo, setConsRestockBatchNo] = useState('');
  const [consUseToUra, setConsUseToUra] = useState(false);
  const [consUseUraType, setConsUseUraType] = useState('102');
  const [savingBizSettings, setSavingBizSettings] = useState(false);
  // Settings is an index of sections, not one long scroll: null shows the cards,
  // a key shows that section on its own. Eight panels stacked in a two-column
  // grid left every one of them cramped.
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  // Team & access management
  interface TeamUser { id: number; username: string; email: string; firstName?: string; lastName?: string; role: string; isActive: boolean; roleName?: string; companyRoleId?: number | null; }
  const [companyUsers, setCompanyUsers] = useState<TeamUser[]>([]);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const [newUser, setNewUser] = useState<{ firstName: string; lastName: string; email: string; username: string; password: string; companyRoleId: number | null }>({ firstName: '', lastName: '', email: '', username: '', password: '', companyRoleId: null });

  // Roles & permissions (tenant RBAC)
  interface CompanyRole { id: number; name: string; description?: string | null; isSystemAdmin: boolean; permissions: Record<string, Record<string, boolean>>; memberCount: number; }
  interface PermModule { key: string; label: string; actions: string[]; financial?: boolean; }
  const [companyRoles, setCompanyRoles] = useState<CompanyRole[]>([]);
  const [permCatalog, setPermCatalog] = useState<PermModule[]>([]);
  const [showRoleEditor, setShowRoleEditor] = useState(false);
  const [editingRole, setEditingRole] = useState<CompanyRole | null>(null);
  const [roleDraft, setRoleDraft] = useState<{ name: string; description: string; permissions: Record<string, Record<string, boolean>> }>({ name: '', description: '', permissions: {} });
  const [savingRole, setSavingRole] = useState(false);
  // Notifications
  interface AppNotification { id: number; category: string; title: string; message: string; link?: string | null; isRead: boolean; createdAt: string; }
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({ overdue: true, lowStock: true, returns: true, payments: true, bookings: true });
  // Global search
  interface SearchGroup { type: string; label: string; tab: string; items: { id: number; label: string; sublabel: string }[]; }
  interface SavedSearch { id: number; name: string; query: string; }
  const [globalQuery, setGlobalQuery] = useState('');
  const [searchGroups, setSearchGroups] = useState<SearchGroup[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [searching, setSearching] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  // Onboarding / setup checklist
  interface OnboardingStep { id: string; label: string; tab: string; done: boolean; }
  const [onboarding, setOnboarding] = useState<{ steps: OnboardingStep[]; percent: number; dismissed: boolean } | null>(null);
  // Quick tour tutorial (client-only UI state — no server persistence needed)
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const TUTORIAL_SLIDES = [
    { title: 'Welcome to YourHires', body: 'This is your rental & event operations workspace. Let\'s walk through the essentials.', tab: 'dashboard' as const },
    { title: 'Bookings', body: 'Capture customer requests here, collect deposits, and dispatch them into active rental orders.', tab: 'bookings' as const },
    { title: 'Dispatches & Returns', body: 'Track active rentals, apply late fees, and reconcile returns — including damaged or lost items.', tab: 'dispatches' as const },
    { title: 'Customer Ledgers', body: 'Every charge and payment is tracked per customer, with an automatic aging breakdown.', tab: 'ledgers' as const },
    { title: 'Items & Assets', body: 'Manage your bulk inventory, serialized equipment, and consumables — with low-stock alerts.', tab: 'inventory' as const },
    { title: 'Settings', body: 'Configure your fee policy, currency, team access, and notification preferences here.', tab: 'settings' as const },
  ];

  // Modals / Forms controllers
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  // A customer's TIN turns their invoices into B2B ones at URA.
  const [newCustTin, setNewCustTin] = useState('');
  const [newContactInfo, setNewContactInfo] = useState('');
  const [newBookingType, setNewBookingType] = useState<'customer' | 'function'>('customer');
  const [newPickupDate, setNewPickupDate] = useState('');
  const [newReturnDate, setNewReturnDate] = useState('');
  const [newDeposit, setNewDeposit] = useState(0);
  const [newBookingLineItems, setNewBookingLineItems] = useState<any[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');

  // Item & Asset creation modals
  const [showItemModal, setShowItemModal] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('Chairs');
  const [newItemUom, setNewItemUom] = useState('piece');
  const [newItemCost, setNewItemCost] = useState(0);
  const [newItemReplacementCost, setNewItemReplacementCost] = useState(0);
  const [newItemRate, setNewItemRate] = useState(0);
  const [newItemStock, setNewItemStock] = useState(0);

  const [showAssetModal, setShowAssetModal] = useState(false);
  const [newAssetName, setNewAssetName] = useState('');
  const [newAssetType, setNewAssetType] = useState('Tents');
  const [newAssetSerial, setNewAssetSerial] = useState('');
  const [newAssetCost, setNewAssetCost] = useState(0);
  const [newAssetRate, setNewAssetRate] = useState(0);
  const [newAssetReplacement, setNewAssetReplacement] = useState(0);

  // Staff & Scheduling Module States
  const [employees, setEmployees] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [functions, setFunctions] = useState<any[]>([]);
  const [functionRoles, setFunctionRoles] = useState<any[]>([]);

  // Sub-tab selection
  const [schedSubTab, setSchedSubTab] = useState<'roster' | 'sites' | 'events'>('roster');

  // Employee Add Modal
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [newEmpName, setNewEmpName] = useState('');
  const [newEmpRole, setNewEmpRole] = useState('');
  const [newEmpBillingRate, setNewEmpBillingRate] = useState(0);
  const [newEmpPayStructure, setNewEmpPayStructure] = useState('Per Function');
  const [newEmpPayRate, setNewEmpPayRate] = useState(0);

  // Site Add Modal
  const [showSiteModal, setShowSiteModal] = useState(false);
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteLocation, setNewSiteLocation] = useState('');
  const [newSiteContactPerson, setNewSiteContactPerson] = useState('');
  const [newSiteContactInfo, setNewSiteContactInfo] = useState('');
  const [newSiteNotes, setNewSiteNotes] = useState('');

  // Site Assign Modal
  const [showAssignSiteModal, setShowAssignSiteModal] = useState(false);
  const [assignSiteId, setAssignSiteId] = useState<number | null>(null);
  const [assignSiteEmployeeId, setAssignSiteEmployeeId] = useState<string>('');
  const [assignSiteIsPrimary, setAssignSiteIsPrimary] = useState(false);
  const [assignSiteNotes, setAssignSiteNotes] = useState('');

  // Event Add Modal
  const [showEventModal, setShowEventModal] = useState(false);
  const [newEventName, setNewEventName] = useState('');
  const [newEventDate, setNewEventDate] = useState('');
  const [newEventTime, setNewEventTime] = useState('');
  const [newEventLocation, setNewEventLocation] = useState('');
  const [newEventClientName, setNewEventClientName] = useState('');
  const [newEventClientContact, setNewEventClientContact] = useState('');
  const [newEventNotes, setNewEventNotes] = useState('');

  // Staff Assignment Modal
  const [showAssignStaffModal, setShowAssignStaffModal] = useState(false);
  const [assignEventId, setAssignEventId] = useState<number | null>(null);
  const [assignEmployeeId, setAssignEmployeeId] = useState<string>('');
  const [assignRoleId, setAssignRoleId] = useState<string>('');
  const [assignStartTime, setAssignStartTime] = useState('');
  const [assignEndTime, setAssignEndTime] = useState('');
  const [assignNotes, setAssignNotes] = useState('');

  // Bookkeeping Module States
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [payrollPeriods, setPayrollPeriods] = useState<any[]>([]);

  // Sub-tab selection
  const [bookkeepingSubTab, setBookkeepingSubTab] = useState<'suppliers' | 'pos' | 'expenses' | 'payroll'>('suppliers');

  // Supplier Add Modal
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState('');
  const [newSupplierPerson, setNewSupplierPerson] = useState('');
  const [newSupplierPhone, setNewSupplierPhone] = useState('');
  const [newSupplierEmail, setNewSupplierEmail] = useState('');
  const [newSupplierAddress, setNewSupplierAddress] = useState('');
  const [newSupplierNotes, setNewSupplierNotes] = useState('');

  // Purchase Order Add Modal
  const [showPOModal, setShowPOModal] = useState(false);
  const [newPOSupplierId, setNewPOSupplierId] = useState('');
  const [newPONumber, setNewPONumber] = useState('');
  const [newPODate, setNewPODate] = useState('');
  const [newPODeliveryDate, setNewPODeliveryDate] = useState('');
  const [newPONotes, setNewPONotes] = useState('');
  const [newPOLineItems, setNewPOLineItems] = useState<{itemId: string, description: string, quantity: number, unitCost: number}[]>([]);

  // Expense Log Modal
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [newExpSupplierId, setNewExpSupplierId] = useState('');
  const [newExpAmount, setNewExpAmount] = useState(0);
  const [newExpCategory, setNewExpCategory] = useState('Fuel');
  const [newExpDate, setNewExpDate] = useState('');
  const [newExpPaymentMethod, setNewExpPaymentMethod] = useState('Cash');
  const [newExpNotes, setNewExpNotes] = useState('');

  // Payroll Period Create Modal
  const [showPayrollPeriodModal, setShowPayrollPeriodModal] = useState(false);
  const [newPayrollStart, setNewPayrollStart] = useState('');
  const [newPayrollEnd, setNewPayrollEnd] = useState('');

  // Pay Employee Modal
  const [showPayEmployeeModal, setShowPayEmployeeModal] = useState(false);
  const [payEmployeePaymentId, setPayEmployeePaymentId] = useState<number | null>(null);
  const [payEmployeeMethod, setPayEmployeeMethod] = useState('Cash');
  const [payEmployeeDate, setPayEmployeeDate] = useState('');
  const [payEmployeeNotes, setPayEmployeeNotes] = useState('');

  // Pay Invoice Modal State
  const [showPayInvoiceModal, setShowPayInvoiceModal] = useState(false);
  const [payInvoiceId, setPayInvoiceId] = useState<number | null>(null);
  const [payInvoiceMethod, setPayInvoiceMethod] = useState('Cash');
  const [payInvoiceDate, setPayInvoiceDate] = useState('');
  const [payInvoiceNotes, setPayInvoiceNotes] = useState('');
  // Blank means "settle the whole outstanding balance", which is the usual case.
  const [payInvoiceAmount, setPayInvoiceAmount] = useState('');

  // CSV Import Modal State
  const [showImportModal, setShowImportModal] = useState(false);
  const [importTarget, setImportTarget] = useState<'customers' | 'items' | 'assets' | 'consumables' | 'employees'>('customers');

  // Session Inactivity States
  const [sessionCookieAge, setSessionCookieAge] = useState(600); // default 10 minutes
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [warningCountdown, setWarningCountdown] = useState(60);

  // Subscription & Billing States
  const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([]);
  const [showBillingModal, setShowBillingModal] = useState(false);
  const [selectedPlanToUpgrade, setSelectedPlanToUpgrade] = useState<SubscriptionPlan | null>(null);
  const [stripeCardName, setStripeCardName] = useState('');
  const [stripeCardNumber, setStripeCardNumber] = useState('');
  const [stripeCardExpiry, setStripeCardExpiry] = useState('');
  const [stripeCardCVC, setStripeCardCVC] = useState('');

  // Loader function
  const fetchAllData = async () => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };

      const configRes = await fetch(`${API_URL}/api/config`);
      if (configRes.ok) {
        const configData = await configRes.json();
        if (configData.sessionCookieAge) {
          setSessionCookieAge(configData.sessionCookieAge);
        }
      }

      const cmpRes = await fetch(`${API_URL}/api/companies`);
      if (cmpRes.ok) {
        const data = await cmpRes.json();
        setCompanies(data);
        if (data.length > 0 && !data.find((c: any) => c.id === selectedCompanyId)) {
          setSelectedCompanyId(data[0].id);
        }
      }

      const itemsRes = await fetch(`${API_URL}/api/items`, { headers });
      if (itemsRes.ok) setItems(await itemsRes.json());

      const bookingsRes = await fetch(`${API_URL}/api/bookings`, { headers });
      if (bookingsRes.ok) {
        const data = await bookingsRes.json();
        setBookings(data.map((b: any) => ({
          ...b,
          scheduledPickupDate: b.scheduledPickupDate ? b.scheduledPickupDate.split('T')[0] : '',
          scheduledReturnDate: b.scheduledReturnDate ? b.scheduledReturnDate.split('T')[0] : '',
        })));
      }

      const ordersRes = await fetch(`${API_URL}/api/rental-orders`, { headers });
      if (ordersRes.ok) {
        const data = await ordersRes.json();
        setRentalOrders(data.map((o: any) => ({
          ...o,
          checkoutDate: o.checkoutDate ? o.checkoutDate.split('T')[0] : '',
          expectedReturnDate: o.expectedReturnDate ? o.expectedReturnDate.split('T')[0] : '',
        })));
      }

      const invsRes = await fetch(`${API_URL}/api/invoices`, { headers });
      if (invsRes.ok) {
        const data = await invsRes.json();
        setInvoices(data.map((inv: any) => ({
          ...inv,
          dueDate: inv.dueDate ? inv.dueDate.split('T')[0] : '',
        })));
      }

      const notesRes = await fetch(`${API_URL}/api/credit-notes`, { headers });
      if (notesRes.ok) {
        const data = await notesRes.json();
        setCreditNotes(data.map((n: any) => ({
          ...n,
          createdAt: n.createdAt ? n.createdAt.split('T')[0] : '',
        })));
      }

      const assetsRes = await fetch(`${API_URL}/api/serialized-assets`, { headers });
      if (assetsRes.ok) {
        setAssets(await assetsRes.json());
      }

      const agingRes = await fetch(`${API_URL}/api/reports/invoice-aging`, { headers });
      if (agingRes.ok) {
        setAgingReport(await agingRes.json());
      }

      const custRes = await fetch(`${API_URL}/api/customers`, { headers });
      if (custRes.ok) setCustomers(await custRes.json());

      const ledRes = await fetch(`${API_URL}/api/customer-accounts`, { headers });
      if (ledRes.ok) setCustomerAccounts(await ledRes.json());

      const empRes = await fetch(`${API_URL}/api/employees`, { headers });
      if (empRes.ok) setEmployees(await empRes.ok ? await empRes.json() : []);

      const sitesRes = await fetch(`${API_URL}/api/sites`, { headers });
      if (sitesRes.ok) setSites(await sitesRes.ok ? await sitesRes.json() : []);

      const funcRes = await fetch(`${API_URL}/api/functions`, { headers });
      if (funcRes.ok) setFunctions(await funcRes.ok ? await funcRes.json() : []);

      const rolesRes = await fetch(`${API_URL}/api/function-roles`, { headers });
      if (rolesRes.ok) setFunctionRoles(await rolesRes.ok ? await rolesRes.json() : []);

      const supRes = await fetch(`${API_URL}/api/suppliers`, { headers });
      if (supRes.ok) setSuppliers(await supRes.ok ? await supRes.json() : []);

      const poRes = await fetch(`${API_URL}/api/purchase-orders`, { headers });
      if (poRes.ok) setPurchaseOrders(await poRes.ok ? await poRes.json() : []);

      const expRes = await fetch(`${API_URL}/api/expenses`, { headers });
      if (expRes.ok) setExpenses(await expRes.ok ? await expRes.json() : []);

      const payRes = await fetch(`${API_URL}/api/payroll-periods`, { headers });
      if (payRes.ok) setPayrollPeriods(await payRes.ok ? await payRes.json() : []);

      const auditRes = await fetch(`${API_URL}/api/audit-logs`, { headers });
      if (auditRes.ok) setAuditLogs(await auditRes.json());

      const backupRes = await fetch(`${API_URL}/api/backup/config`, { headers });
      if (backupRes.ok) setBackupInfo(await backupRes.json());

      const alertsRes = await fetch(`${API_URL}/api/dashboard/function-alerts`, { headers });
      if (alertsRes.ok) setFunctionAlerts(await alertsRes.json());

      const plansRes = await fetch(`${API_URL}/api/subscription-plans`);
      if (plansRes.ok) setSubscriptionPlans(await plansRes.json());

      const incRes = await fetch(`${API_URL}/api/income`, { headers });
      if (incRes.ok) setIncomeRecords(await incRes.json());

      const incAnalyticRes = await fetch(`${API_URL}/api/income/analytics`, { headers });
      if (incAnalyticRes.ok) setIncomeAnalytics(await incAnalyticRes.json());

      const consRes = await fetch(`${API_URL}/api/consumables`, { headers });
      if (consRes.ok) setConsumables(await consRes.json());

      const uomRes = await fetch(`${API_URL}/api/uoms`, { headers });
      if (uomRes.ok) setUoms(await uomRes.json());

      await fetchHelpCategories();
      await fetchHelpArticles();
      await fetchHelpFaqs();
      await fetchSystemComponents();
      await fetchSystemIncidents();
      await fetchOnboardingStatus();
      await fetchFunctionTemplates();

    } catch (err) {
      console.error("Failed to load initial data from API:", err);
    }
  };

  const fetchDashboardStats = async () => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const catParam = analyticsCategory === 'All' ? '' : analyticsCategory;
      const res = await fetch(`${API_URL}/api/reports/dashboard-stats?startDate=${analyticsStartDate}&endDate=${analyticsEndDate}&category=${catParam}&customerName=${analyticsCustomer}`, { headers });
      if (res.ok) {
        setDashboardStats(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch dashboard stats:", err);
    }
  };

  const fetchOverdueAlerts = async () => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/dashboard/overdue-alerts`, { headers });
      if (res.ok) setOverdueAlerts(await res.json());
    } catch (err) {
      console.error('Failed to fetch overdue alerts:', err);
    }
  };

  const handleApplyLateFee = async (orderId: number) => {
    setApplyingLateFee(orderId);
    try {
      const res = await fetch(`${API_URL}/api/rental-orders/${orderId}/apply-late-fee`, {
        method: 'POST',
        headers: { 'x-company-id': selectedCompanyId.toString() }
      });
      if (res.ok) {
        await fetchOverdueAlerts();
        await fetchAllData();
      }
    } catch (err) {
      console.error('Failed to apply late fee:', err);
    } finally {
      setApplyingLateFee(null);
    }
  };

  useEffect(() => {
    fetchAllData();
  }, [selectedCompanyId]);

  useEffect(() => {
    fetchDashboardStats();
    fetchOverdueAlerts();
  }, [analyticsStartDate, analyticsEndDate, analyticsCategory, analyticsCustomer, selectedCompanyId]);

  useEffect(() => {
    fetchIncomeRecords();
    fetchIncomeAnalytics();
  }, [revenueSearch, revenueSourceFilter, revenueMethodFilter, revenueStartDate, revenueEndDate, revenueCategoryFilter, revenueCustomerFilter, selectedCompanyId]);

  useEffect(() => {
    fetchHelpArticles();
  }, [helpSearch, selectedHelpCategory]);

  // Support loads on its own rather than inside the main data chain: that chain is one
  // long sequence of awaits in a single try, so anything that throws earlier silently
  // skips everything after it — and support must not depend on 40 unrelated calls.
  useEffect(() => {
    if (!currentUser) return;
    fetchSupportStatus();
    fetchSupportTickets();
  }, [currentUser]);

  useEffect(() => {
    fetchSystemIncidents();
  }, [selectedSystemComponent]);

  // Activity Monitor & Idle Session Timeout Hook
  useEffect(() => {
    if (!currentUser) return;

    let lastActivity = Date.now();
    
    const handleUserActivity = () => {
      lastActivity = Date.now();
    };

    window.addEventListener('mousemove', handleUserActivity);
    window.addEventListener('mousedown', handleUserActivity);
    window.addEventListener('keypress', handleUserActivity);
    window.addEventListener('scroll', handleUserActivity);
    window.addEventListener('touchstart', handleUserActivity);

    const checkInterval = setInterval(() => {
      const now = Date.now();
      const idleTimeSeconds = Math.floor((now - lastActivity) / 1000);
      const warningThreshold = sessionCookieAge - 60;

      if (idleTimeSeconds >= sessionCookieAge) {
        clearInterval(checkInterval);
        handleLogout();
        alert('Session Expired: You have been logged out due to inactivity.');
      } else if (idleTimeSeconds >= warningThreshold) {
        setShowTimeoutWarning(true);
        setWarningCountdown(sessionCookieAge - idleTimeSeconds);
      } else {
        setShowTimeoutWarning(false);
      }
    }, 1000);

    return () => {
      window.removeEventListener('mousemove', handleUserActivity);
      window.removeEventListener('mousedown', handleUserActivity);
      window.removeEventListener('keypress', handleUserActivity);
      window.removeEventListener('scroll', handleUserActivity);
      window.removeEventListener('touchstart', handleUserActivity);
      clearInterval(checkInterval);
    };
  }, [currentUser, sessionCookieAge]);

  // Apply dark mode class to root
  useEffect(() => {
    const root = window.document.documentElement;
    if (isDarkMode) {
      root.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDarkMode]);

  // Utility calculations
  const calculateDays = (start: string, end: string) => {
    if (!start || !end) return 1;
    const diff = new Date(end).getTime() - new Date(start).getTime();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return days > 0 ? days : 1;
  };

  const calculateBookingTotal = (lineItems: any[], pickup: string, returnD: string) => {
    const days = calculateDays(pickup, returnD);
    return lineItems.reduce((acc, current) => {
      if (current.itemType === 'consumable') {
        const cons = consumables.find(c => c.id === current.consumableId);
        if (!cons) return acc;
        const rate = Number(current.unitOfMeasureId) === cons.packageUnitId ? Number(cons.packagePrice) : Number(cons.unitPrice);
        return acc + (rate * current.quantity);
      } else {
        const item = items.find(i => i.id === current.itemId);
        if (!item) return acc;
        return acc + (item.dailyRentalRate * current.quantity * days);
      }
    }, 0);
  };

  // Add Item to New Booking Form
  const handleAddItemToBooking = (id: number, type: 'item' | 'consumable', uomId: number | null = null) => {
    if (type === 'item') {
      const existing = newBookingLineItems.find(item => item.itemType === 'item' && item.itemId === id);
      if (existing) {
        setNewBookingLineItems(newBookingLineItems.map(item => 
          (item.itemType === 'item' && item.itemId === id) ? { ...item, quantity: item.quantity + 1 } : item
        ));
      } else {
        setNewBookingLineItems([...newBookingLineItems, { itemType: 'item', itemId: id, quantity: 1 }]);
      }
    } else {
      const existing = newBookingLineItems.find(item => item.itemType === 'consumable' && item.consumableId === id && item.unitOfMeasureId === uomId);
      if (existing) {
        setNewBookingLineItems(newBookingLineItems.map(item => 
          (item.itemType === 'consumable' && item.consumableId === id && item.unitOfMeasureId === uomId) ? { ...item, quantity: item.quantity + 1 } : item
        ));
      } else {
        setNewBookingLineItems([...newBookingLineItems, { itemType: 'consumable', consumableId: id, unitOfMeasureId: uomId, quantity: 1 }]);
      }
    }
  };

  // Create Booking Action via API
  const handleCreateBooking = async () => {
    if (!newCustomerName || !newPickupDate || !newReturnDate || newBookingLineItems.length === 0) {
      alert("Please fill in all required fields and add at least one item.");
      return;
    }
    
    try {
      const res = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          customerName: newCustomerName,
          contactInfo: newContactInfo,
          bookingType: newBookingType,
          scheduledPickupDate: newPickupDate,
          scheduledReturnDate: newReturnDate,
          depositAmount: newDeposit,
          lineItems: newBookingLineItems
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create booking");
      }

      await fetchAllData();
      
      // Reset Form
      setNewCustomerName('');
      setNewContactInfo('');
      setNewBookingType('customer');
      setNewPickupDate('');
      setNewReturnDate('');
      setNewDeposit(0);
      setNewBookingLineItems([]);
      setCatalogSearch('');
      setShowBookingModal(false);
    } catch (err: any) {
      alert(`Error creating booking: ${err.message}`);
    }
  };

  // Confirm Deposit Payment via API
  const handleConfirmDeposit = async (bookingId: number) => {
    try {
      const res = await fetch(`${API_URL}/api/bookings/${bookingId}/confirm-deposit`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error("Failed to confirm deposit");
      await fetchAllData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Dispatch Rental Order via API
  const handleDispatchBooking = async (booking: Booking) => {
    try {
      const res = await fetch(`${API_URL}/api/bookings/${booking.id}/dispatch`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error("Failed to dispatch booking");
      await fetchAllData();
      setActiveTab('dispatches');
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Open the reconciliation modal, seeding each rentable line's inputs
  // to "all returned in good condition" as the default.
  const openReturnModal = (order: RentalOrder) => {
    const rentable = (order.lineItems || []).filter(li => li.itemType !== 'consumable');
    const seed: Record<number, { returned: number; damaged: number; lost: number }> = {};
    rentable.forEach(li => {
      const outstanding = (li.rentedQty || 0) - (li.returnedQty + li.damagedQty + li.lostQty);
      seed[li.id] = { returned: Math.max(0, outstanding), damaged: 0, lost: 0 };
    });
    setReturnOrder(order);
    setReturnLines(seed);
    setReturnNotes('');
  };

  // Live fee preview mirroring the server's formula (uses company settings).
  const returnFeePreview = () => {
    if (!returnOrder) return { damage: 0, late: 0, daysOverdue: 0 };
    const company = companies.find(c => c.id === selectedCompanyId) as any;
    const damagePct = Number(company?.damageFeePercent ?? 50) / 100;
    const lostPct = Number(company?.lostFeePercent ?? 100) / 100;
    const latePct = Number(company?.lateFeePercentPerDay ?? 10) / 100;
    const rentable = (returnOrder.lineItems || []).filter(li => li.itemType !== 'consumable');
    let damage = 0;
    rentable.forEach(li => {
      const l = returnLines[li.id]; if (!l) return;
      const repl = li.itemType === 'asset' ? Number(li.asset?.replacementCost || 0) : Number(li.item?.unitReplacementCost || 0);
      damage += l.damaged * repl * damagePct + l.lost * repl * lostPct;
    });
    const daysOverdue = Math.max(0, Math.ceil((Date.now() - new Date(returnOrder.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)));
    let late = 0;
    if (daysOverdue > 0) {
      (returnOrder.lineItems || []).forEach(li => { late += Number(li.dailyRate) * latePct * daysOverdue * (li.rentedQty || 0); });
    }
    return { damage: Math.round(damage), late: Math.round(late), daysOverdue };
  };

  // Submit the reconciliation to the API
  const handleSubmitReturn = async () => {
    if (!returnOrder) return;
    const rentable = (returnOrder.lineItems || []).filter(li => li.itemType !== 'consumable');
    // Validate: reconciled qty must not exceed outstanding per line.
    for (const li of rentable) {
      const l = returnLines[li.id]; if (!l) continue;
      const outstanding = (li.rentedQty || 0) - (li.returnedQty + li.damagedQty + li.lostQty);
      if (l.returned + l.damaged + l.lost > outstanding) {
        alert(`"${li.item?.name || li.asset?.name || 'Item'}": returned + damaged + lost (${l.returned + l.damaged + l.lost}) exceeds outstanding quantity (${outstanding}).`);
        return;
      }
    }
    setProcessingReturn(true);
    try {
      const lines = rentable.map(li => ({
        lineItemId: li.id,
        returnedQty: returnLines[li.id]?.returned || 0,
        damagedQty: returnLines[li.id]?.damaged || 0,
        lostQty: returnLines[li.id]?.lost || 0,
      }));
      const res = await fetch(`${API_URL}/api/rental-orders/${returnOrder.id}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
        body: JSON.stringify({ lines, notes: returnNotes })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to process return');
      setReturnOrder(null);
      await fetchAllData();
      alert(`Return reconciled (${data.status}). Late fee: ${companyCurrency} ${Number(data.lateFee || 0).toLocaleString()}, Damage/loss: ${companyCurrency} ${Number(data.replacementFee || 0).toLocaleString()}.`);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setProcessingReturn(false);
    }
  };

  // Seed the Business Settings form whenever the active company data loads/changes.
  useEffect(() => {
    const c = companies.find(x => x.id === selectedCompanyId) as any;
    if (!c) return;
    setBizSettings({
      currency: c.currency ?? 'UGX',
      defaultPaymentTermsDays: Number(c.defaultPaymentTermsDays ?? 30),
      lateFeePercentPerDay: Number(c.lateFeePercentPerDay ?? 10),
      damageFeePercent: Number(c.damageFeePercent ?? 50),
      lostFeePercent: Number(c.lostFeePercent ?? 100),
      restockReturnedItems: c.restockReturnedItems ?? true,
      pricesIncludeTax: c.pricesIncludeTax ?? true,
    });
  }, [companies, selectedCompanyId]);

  // Whether to show the fiscalize actions. Cheap and unguarded, so it can be
  // re-read after any EFRIS settings change without a permission round-trip.
  const refreshEfrisConfig = async () => {
    try {
      const res = await fetch(`${API_URL}/api/efris/config`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) setEfrisConfig(await res.json());
    } catch { /* EFRIS actions simply stay hidden */ }
  };
  useEffect(() => { refreshEfrisConfig(); }, [selectedCompanyId]);

  // The catalogue editor offers the business's own rates, so they're loaded here
  // rather than inside the dialog — the list barely changes and every row needs it.
  const refreshTaxRates = async () => {
    try {
      const res = await fetch(`${API_URL}/api/tax-rates`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) setTaxRatesList(await res.json());
    } catch { /* the dialog falls back to "business default" only */ }
  };
  useEffect(() => { refreshTaxRates(); }, [selectedCompanyId]);

  // ── URA EFRIS actions ──

  const fiscalizeInvoice = async (invoice: Invoice) => {
    if (invoice.efrisFDN) { openFiscalInvoice(invoice); return; }
    if (!confirm(`Report invoice ${invoice.referenceNumber} to URA?\n\nOnce fiscalized its figures are fixed — a correction needs a credit note.`)) return;
    setFiscalizingId(invoice.id);
    try {
      const res = await fetch(`${API_URL}/api/invoices/${invoice.id}/fiscalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fiscalization failed.');
      await fetchAllData();
      alert(`Fiscalized with URA.\n\nFDN: ${data.efris?.fdn || '—'}`);
      await openFiscalInvoice(invoice);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setFiscalizingId(null);
    }
  };

  // Re-reads the invoice so the fiscal view always renders stored URA data
  // rather than whatever the list happened to be holding.
  const openFiscalInvoice = async (invoice: Invoice) => {
    try {
      const res = await fetch(`${API_URL}/api/invoices/${invoice.id}`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      setFiscalInvoice(res.ok ? await res.json() : invoice);
    } catch {
      setFiscalInvoice(invoice);
    }
  };

  const fiscalizeCreditNote = async (note: CreditNote) => {
    setFiscalizingId(note.id);
    try {
      const res = await fetch(`${API_URL}/api/credit-notes/${note.id}/fiscalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fiscalization failed.');
      await fetchAllData();
      alert(`Credit note fiscalized with URA.\n\nFDN: ${data.efris?.fdn || '—'}`);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setFiscalizingId(null);
    }
  };

  // The "Tax & URA" button shared by the three catalogue tables. It doubles as the
  // registration state, so an operator can see at a glance what URA already knows.
  const renderTaxUraCell = (entry: any) => (
    <button
      onClick={() => setTaxTarget({
        kind: entry.kind,
        id: entry.id,
        name: entry.name,
        sku: entry.sku,
        unitOfMeasureId: entry.unitOfMeasureId,
        taxRateId: entry.taxRateId,
        commodityCode: entry.commodityCode,
        haveExciseTax: entry.haveExciseTax,
        exciseDutyCode: entry.exciseDutyCode,
        efrisRegisteredAt: entry.efrisRegisteredAt,
      })}
      className={`px-2 py-1 text-[9px] font-bold rounded-lg active-shrink transition-all cursor-pointer ${
        entry.efrisRegisteredAt
          ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
          : 'bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-slate-500'
      }`}
      title={entry.efrisRegisteredAt ? 'Registered with URA — open to review' : 'Set the tax rate and URA details'}
    >
      {entry.efrisRegisteredAt ? '✓ URA' : 'Tax & URA'}
    </button>
  );

  // Open a server-generated PDF in a new tab. A plain window.open can't send
  // the session header (and the company is taken from the session, never the
  // URL), so fetch it authenticated and hand the tab a blob URL. The tab is
  // opened synchronously so popup blockers allow it.
  const openServerPdf = async (path: string) => {
    const win = window.open('', '_blank');
    try {
      const res = await fetch(`${API_URL}${path}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Could not load the document (${res.status}).`);
      }
      const url = URL.createObjectURL(await res.blob());
      if (win) win.location.href = url; else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: any) {
      if (win) win.close();
      alert(err.message);
    }
  };

  // Load the company's team roster once the user is authenticated.
  useEffect(() => {
    if (currentUser && selectedCompanyId) fetchCompanyUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, selectedCompanyId]);

  // Load notifications + preferences and poll for new ones every 60s.
  useEffect(() => {
    if (!currentUser || !selectedCompanyId) return;
    fetchNotifPrefs();
    fetchNotifications();
    fetchSavedSearches();
    const t = setInterval(fetchNotifications, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, selectedCompanyId]);

  // Debounced global search as the user types.
  useEffect(() => {
    if (globalQuery.trim().length < 2) { setSearchGroups([]); setSearchTotal(0); return; }
    const t = setTimeout(() => runGlobalSearch(globalQuery), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalQuery]);

  const handleSaveBizSettings = async () => {
    setSavingBizSettings(true);
    try {
      const res = await fetch(`${API_URL}/api/companies/${selectedCompanyId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
        body: JSON.stringify(bizSettings)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save settings');
      await fetchAllData();
      alert('Business settings saved.');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSavingBizSettings(false);
    }
  };

  // ── Team & access management ──
  const companyHeaders = () => ({ 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) });

  const fetchCompanyUsers = async () => {
    try {
      const res = await fetch(`${API_URL}/api/company/users`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) setCompanyUsers(await res.json());
    } catch { /* ignore */ }
  };

  const fetchCompanyRoles = async () => {
    try {
      const res = await fetch(`${API_URL}/api/company/roles`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) setCompanyRoles(await res.json());
    } catch { /* ignore */ }
  };

  const fetchPermCatalog = async () => {
    if (permCatalog.length) return;
    try {
      const res = await fetch(`${API_URL}/api/permissions/catalog`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) { const d = await res.json(); setPermCatalog(d.modules || []); }
    } catch { /* ignore */ }
  };

  const handleAddUser = async () => {
    if (!newUser.firstName || !newUser.lastName || !newUser.email || !newUser.username || !newUser.password) {
      return alert('All fields are required.');
    }
    setSavingUser(true);
    try {
      const res = await fetch(`${API_URL}/api/company/users`, { method: 'POST', headers: companyHeaders(), body: JSON.stringify(newUser) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add user');
      setShowAddUserModal(false);
      setNewUser({ firstName: '', lastName: '', email: '', username: '', password: '', companyRoleId: null });
      await fetchCompanyUsers();
      alert('Team member added.');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSavingUser(false);
    }
  };

  const handleUpdateUser = async (id: number, patch: { role?: string; isActive?: boolean; companyRoleId?: number }) => {
    try {
      const res = await fetch(`${API_URL}/api/company/users/${id}`, { method: 'PATCH', headers: companyHeaders(), body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update user');
      await fetchCompanyUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRemoveUser = async (id: number, username: string) => {
    if (!confirm(`Remove team member "${username}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${API_URL}/api/company/users/${id}`, { method: 'DELETE', headers: { 'x-company-id': String(selectedCompanyId) } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove user');
      await fetchCompanyUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  // ── Roles & permissions management ──
  // Build an empty permission matrix from the catalog (all false).
  const emptyMatrix = () => {
    const m: Record<string, Record<string, boolean>> = {};
    for (const mod of permCatalog) { m[mod.key] = {}; for (const a of mod.actions) m[mod.key][a] = false; }
    return m;
  };

  const openRoleEditor = (role: CompanyRole | null) => {
    if (role) {
      // Merge stored perms over an empty matrix so any new catalog keys appear.
      const base = emptyMatrix();
      for (const mod of permCatalog) for (const a of mod.actions) base[mod.key][a] = !!role.permissions?.[mod.key]?.[a];
      setEditingRole(role);
      setRoleDraft({ name: role.name, description: role.description || '', permissions: base });
    } else {
      setEditingRole(null);
      setRoleDraft({ name: '', description: '', permissions: emptyMatrix() });
    }
    setShowRoleEditor(true);
  };

  const toggleRolePerm = (moduleKey: string, action: string) => {
    setRoleDraft(d => ({ ...d, permissions: { ...d.permissions, [moduleKey]: { ...d.permissions[moduleKey], [action]: !d.permissions[moduleKey]?.[action] } } }));
  };

  const handleSaveRole = async () => {
    if (!roleDraft.name.trim()) return alert('Enter a role name.');
    setSavingRole(true);
    try {
      const url = editingRole ? `${API_URL}/api/company/roles/${editingRole.id}` : `${API_URL}/api/company/roles`;
      const method = editingRole ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: companyHeaders(), body: JSON.stringify(roleDraft) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save role');
      setShowRoleEditor(false);
      await fetchCompanyRoles();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSavingRole(false);
    }
  };

  const handleDeleteRole = async (role: CompanyRole) => {
    if (!confirm(`Delete the "${role.name}" role?`)) return;
    try {
      const res = await fetch(`${API_URL}/api/company/roles/${role.id}`, { method: 'DELETE', headers: { 'x-company-id': String(selectedCompanyId) } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete role');
      await fetchCompanyRoles();
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Load roles + permission catalog when a permitted user is active.
  useEffect(() => {
    if (currentUser && can('team', 'manage')) { fetchCompanyRoles(); fetchPermCatalog(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, selectedCompanyId]);

  // ── Database backup & restore ──
  const handleRunBackup = async () => {
    setBackupBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/backup/run`, { method: 'POST', headers: companyHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Backup failed');
      setBackupInfo({ config: backupInfo!.config, backups: data.backups, lastBackup: data.lastBackup });
      const prunedNote = data.pruned?.length ? ` ${data.pruned.length} old backup(s) pruned.` : '';
      alert(`Backup created: ${data.file} (${(data.size / 1024).toFixed(0)} KB).${prunedNote}`);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleSaveBackupConfig = async (patch: Partial<BackupState['config']>) => {
    try {
      const res = await fetch(`${API_URL}/api/backup/config`, { method: 'PUT', headers: companyHeaders(), body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save settings');
      setBackupInfo(data);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteBackup = async (name: string) => {
    if (!confirm(`Delete backup "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${API_URL}/api/backup/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'x-company-id': String(selectedCompanyId) } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setBackupInfo(prev => prev ? { ...prev, backups: data.backups, lastBackup: data.lastBackup } : prev);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDownloadBackup = async (name: string) => {
    try {
      const res = await fetch(`${API_URL}/api/backup/download/${encodeURIComponent(name)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not download the backup.');
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRestoreBackup = async (name: string) => {
    if (!confirm(`Restore the database from "${name}"?\n\nThis OVERWRITES all current data. A safety backup of the current state is taken automatically first.`)) return;
    setBackupBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/backup/restore`, { method: 'POST', headers: companyHeaders(), body: JSON.stringify({ name, confirm: 'RESTORE' }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Restore failed');
      alert(`Database restored from ${name}.\nSafety backup of the previous state: ${data.safetyBackup}\n\nThe app will now reload.`);
      window.location.reload();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBackupBusy(false);
    }
  };

  // ── Desktop licensing ──
  const handleActivateLicense = async () => {
    const key = licenseKeyInput.trim();
    if (!key) return alert('Paste your license key first.');
    setActivatingLicense(true);
    try {
      const res = await fetch(`${API_URL}/api/license/activate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Activation failed');
      setLicenseStatus(data);
      setLicenseKeyInput('');
      alert('License activated — thank you!');
      if (data.blocked === false) window.location.reload();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActivatingLicense(false);
    }
  };

  const copyFingerprint = () => {
    if (licenseStatus?.fingerprint) {
      navigator.clipboard?.writeText(licenseStatus.fingerprint).then(
        () => alert('Machine fingerprint copied to clipboard.'),
        () => {}
      );
    }
  };

  // ── Super-admin (platform) console ──
  const fetchAdminData = async () => {
    try {
      const [mRes, cRes] = await Promise.all([
        fetch(`${API_URL}/api/admin/metrics`),
        fetch(`${API_URL}/api/admin/companies`),
      ]);
      if (mRes.ok) setAdminMetrics(await mRes.json());
      if (cRes.ok) setAdminCompanies(await cRes.json());
    } catch { /* ignore */ }
  };

  const handleAdminUpdateCompany = async (id: number, patch: any, confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setAdminBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/admin/companies/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      await fetchAdminData();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setAdminBusy(false);
    }
  };

  const handleAdminGenerateKey = async () => {
    if (!adminGenFp.trim()) return alert("Enter the customer's machine fingerprint.");
    setAdminBusy(true);
    setAdminGenKey('');
    try {
      const res = await fetch(`${API_URL}/api/admin/licenses/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: adminGenFp.trim(), days: adminGenDays, licensee: adminGenLicensee }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Key generation failed');
      setAdminGenKey(data.key);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setAdminBusy(false);
    }
  };

  // Load platform data once a superuser is signed in.
  useEffect(() => {
    if (currentUser?.user?.isSuperuser && currentUser?.adminToken) fetchAdminData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // ── Notifications ──
  const CAT_TO_PREF: Record<string, string> = { overdue: 'overdue', low_stock: 'lowStock', return: 'returns', payment: 'payments', booking: 'bookings' };
  const CAT_META: Record<string, { label: string; color: string; icon: any }> = {
    overdue: { label: 'Overdue', color: 'text-red-500', icon: AlertTriangle },
    low_stock: { label: 'Low Stock', color: 'text-amber-500', icon: AlertCircle },
    return: { label: 'Return', color: 'text-blue-500', icon: Truck },
    payment: { label: 'Payment', color: 'text-green-600 dark:text-green-400', icon: DollarSign },
    booking: { label: 'Booking', color: 'text-indigo-500', icon: CalendarRange },
    system: { label: 'System', color: 'text-slate-500', icon: Activity },
  };
  // Notifications the current user wants to see, per their preferences.
  const visibleNotifications = notifications.filter(n => {
    const pref = CAT_TO_PREF[n.category];
    return pref ? notifPrefs[pref] !== false : true;
  });
  const visibleUnread = visibleNotifications.filter(n => !n.isRead).length;

  const fetchNotifications = async () => {
    try {
      const res = await fetch(`${API_URL}/api/notifications`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) { const j = await res.json(); setNotifications(j.notifications); }
    } catch { /* ignore */ }
  };

  const fetchNotifPrefs = async () => {
    const uid = currentUser?.user?.id;
    if (!uid) return;
    try {
      const res = await fetch(`${API_URL}/api/notifications/preferences?userId=${uid}`);
      if (res.ok) { const p = await res.json(); setNotifPrefs({ overdue: p.overdue, lowStock: p.lowStock, returns: p.returns, payments: p.payments, bookings: p.bookings }); }
    } catch { /* ignore */ }
  };

  const markNotifRead = async (id: number) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
    try { await fetch(`${API_URL}/api/notifications/${id}/read`, { method: 'POST', headers: { 'x-company-id': String(selectedCompanyId) } }); } catch { /* ignore */ }
  };

  const markAllNotifsRead = async () => {
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    try { await fetch(`${API_URL}/api/notifications/mark-all-read`, { method: 'POST', headers: { 'x-company-id': String(selectedCompanyId) } }); } catch { /* ignore */ }
  };

  const saveNotifPref = async (key: string, value: boolean) => {
    setNotifPrefs(prev => ({ ...prev, [key]: value }));
    const uid = currentUser?.user?.id;
    if (!uid) return;
    try {
      await fetch(`${API_URL}/api/notifications/preferences`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid, [key]: value })
      });
    } catch { /* ignore */ }
  };

  // ── Global search ──
  const fetchSavedSearches = async () => {
    const uid = currentUser?.user?.id;
    try {
      const res = await fetch(`${API_URL}/api/saved-searches?userId=${uid || ''}`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) setSavedSearches(await res.json());
    } catch { /* ignore */ }
  };

  const runGlobalSearch = async (q: string) => {
    if (q.trim().length < 2) { setSearchGroups([]); setSearchTotal(0); return; }
    setSearching(true);
    try {
      const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(q)}`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) { const j = await res.json(); setSearchGroups(j.groups); setSearchTotal(j.total); }
    } catch { /* ignore */ } finally { setSearching(false); }
  };

  const openSearchResult = (tab: string) => {
    setActiveTab(tab as typeof activeTab);
    setShowSearchPanel(false);
    setGlobalQuery('');
  };

  const saveCurrentSearch = async () => {
    if (globalQuery.trim().length < 2) return;
    const name = prompt('Name this saved search:', globalQuery.trim());
    if (!name) return;
    try {
      const res = await fetch(`${API_URL}/api/saved-searches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
        body: JSON.stringify({ userId: currentUser?.user?.id, name, query: globalQuery.trim() })
      });
      if (res.ok) await fetchSavedSearches();
    } catch { /* ignore */ }
  };

  const deleteSavedSearch = async (id: number) => {
    try {
      await fetch(`${API_URL}/api/saved-searches/${id}`, { method: 'DELETE', headers: { 'x-company-id': String(selectedCompanyId) } });
      await fetchSavedSearches();
    } catch { /* ignore */ }
  };

  // ── Onboarding checklist ──
  const fetchOnboardingStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/onboarding/status`, { headers: { 'x-company-id': String(selectedCompanyId) } });
      if (res.ok) setOnboarding(await res.json());
    } catch { /* ignore */ }
  };

  const dismissOnboarding = async () => {
    setOnboarding(prev => prev ? { ...prev, dismissed: true } : prev);
    try {
      await fetch(`${API_URL}/api/onboarding/dismiss`, { method: 'POST', headers: { 'x-company-id': String(selectedCompanyId) } });
    } catch { /* ignore */ }
  };

  // Issue Credit Note via API
  // URA needs a reason code on a credit note, not just free text, so this opens
  // a dialog rather than firing straight off. When the invoice was fiscalized
  // the credit note is reported to URA in the same step.
  const handleIssueCreditNote = (invoice: Invoice) => {
    setCreditMemoInvoice(invoice);
    setCreditMemoReason('');
    setCreditMemoCode('101');
  };

  const submitCreditMemo = async () => {
    if (!creditMemoInvoice) return;
    setIssuingCreditMemo(true);
    try {
      const res = await fetch(`${API_URL}/api/invoices/${creditMemoInvoice.id}/credit-memo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
        body: JSON.stringify({
          reason: creditMemoReason.trim() || 'Billing adjustment',
          reasonCode: creditMemoCode,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to issue credit memo');
      await fetchAllData();
      setCreditMemoInvoice(null);
      alert(data.efris?.fdn
        ? `Credit note ${data.referenceNumber} issued and fiscalized with URA.\n\nFDN: ${data.efris.fdn}`
        : data.efris?.error
          ? `Credit note ${data.referenceNumber} issued, but URA rejected it: ${data.efris.error}`
          : `Credit note ${data.referenceNumber} issued.`);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIssuingCreditMemo(false);
    }
  };

  const handleCreateItem = async () => {
    if (!newItemName || !newItemCategory) {
      alert("Name and Category are required.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: newItemName,
          category: newItemCategory,
          unitOfMeasure: newItemUom,
          unitCost: newItemCost,
          unitReplacementCost: newItemReplacementCost,
          dailyRentalRate: newItemRate,
          currentStock: newItemStock
        })
      });
      if (!res.ok) throw new Error("Failed to create item.");
      await fetchAllData();
      setNewItemName('');
      setNewItemCost(0);
      setNewItemReplacementCost(0);
      setNewItemRate(0);
      setNewItemStock(0);
      setShowItemModal(false);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateAsset = async () => {
    if (!newAssetName || !newAssetSerial) {
      alert("Name and Serial Number are required.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/serialized-assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: newAssetName,
          assetType: newAssetType,
          serialNumber: newAssetSerial,
          costPrice: newAssetCost,
          dailyRentalRate: newAssetRate,
          replacementCost: newAssetReplacement,
          status: "Available"
        })
      });
      if (!res.ok) throw new Error("Failed to create asset.");
      await fetchAllData();
      setNewAssetName('');
      setNewAssetSerial('');
      setNewAssetCost(0);
      setNewAssetRate(0);
      setNewAssetReplacement(0);
      setShowAssetModal(false);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateAssetStatus = async (assetId: number, status: string) => {
    try {
      const res = await fetch(`${API_URL}/api/serialized-assets/${assetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!res.ok) throw new Error("Failed to update status.");
      await fetchAllData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  // ── CUSTOMER HANDLERS ──────────────────────────────────────────────────
  const handleCreateCustomer = async () => {
    if (!newCustName) { alert('Customer name is required.'); return; }
    try {
      const res = await fetch(`${API_URL}/api/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, name: newCustName, contactInfo: newCustContact, taxId: newCustTin })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await fetchAllData();
      setNewCustName('');
      setNewCustContact('');
      setNewCustTin('');
      setShowCustomerModal(false);
    } catch (err: any) { alert(err.message); }
  };

  const handleToggleWatchlist = async (customer: Customer) => {
    const newState = !customer.isOnWatchList;
    const reason = newState ? prompt('Enter watchlist reason (optional):') ?? '' : '';
    try {
      const res = await fetch(`${API_URL}/api/customers/${customer.id}/watchlist`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOnWatchList: newState, watchListReason: reason })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
  };

  const handleViewCustomerHistory = async (customerId: number) => {
    try {
      const res = await fetch(`${API_URL}/api/customers/${customerId}/history`);
      if (!res.ok) throw new Error('Failed to load history');
      const data = await res.json();
      setCustomerHistory(data);
      setCustomerHistoryId(customerId);
    } catch (err: any) { alert(err.message); }
  };

  // ── CUSTOMER ACCOUNT LEDGER HANDLERS ──────────────────────────────────
  const fetchCustomerAccounts = async () => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/customer-accounts`, { headers });
      if (res.ok) setCustomerAccounts(await res.json());
    } catch (err: any) { console.error('Failed to load accounts:', err); }
  };

  const fetchAccountDetails = async (customerId: number) => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/customer-accounts/${customerId}`, { headers });
      if (!res.ok) throw new Error('Failed to load account details.');
      const data = await res.json();
      setSelectedAccountDetails(data);
      setSelectedAccountId(customerId);
      setEditCreditLimit(data.account.creditLimit.toString());
      setEditPaymentTerms(data.account.paymentTermsDays.toString());
    } catch (err: any) { alert(err.message); }
  };

  const handleRecalculateAccounts = async () => {
    setRecalculatingAccounts(true);
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/customer-accounts/recalculate`, {
        method: 'POST',
        headers
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to recalculate accounts.');
      alert(data.message);
      await fetchCustomerAccounts();
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
    finally { setRecalculatingAccounts(false); }
  };

  const handleUpdateAccountSettings = async () => {
    if (!selectedAccountId) return;
    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/customer-accounts/${selectedAccountId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          creditLimit: parseFloat(editCreditLimit) || 0,
          paymentTermsDays: parseInt(editPaymentTerms) || 30
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Settings updated successfully.');
      setEditingSettings(false);
      await fetchAccountDetails(selectedAccountId);
      await fetchCustomerAccounts();
    } catch (err: any) { alert(err.message); }
  };

  const handleSubmitManualTransaction = async () => {
    if (!selectedAccountId) return;
    if (!adjAmount || parseFloat(adjAmount) <= 0) return alert('Amount must be positive.');
    if (!adjDescription) return alert('Description is required.');

    try {
      // For payments, refunds, and credit memos, we store them as negative amounts in the DB (credits)
      const isCreditType = ['payment', 'credit_memo', 'refund'].includes(adjType);
      const finalAmount = isCreditType ? -Math.abs(parseFloat(adjAmount)) : Math.abs(parseFloat(adjAmount));

      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/customer-accounts/${selectedAccountId}/transactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          transactionType: adjType,
          amount: finalAmount,
          description: adjDescription,
          referenceNumber: adjReference,
          dueDate: adjDueDate || undefined
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Transaction posted successfully.');
      // Reset form
      setAdjAmount('');
      setAdjDescription('');
      setAdjReference('');
      setAdjDueDate('');
      setShowManualAdjustmentModal(false);
      await fetchAccountDetails(selectedAccountId);
      await fetchCustomerAccounts();
    } catch (err: any) { alert(err.message); }
  };

  // ── 💵 CONSOLIDATED REVENUE LEDGER HANDLERS ─────────────────────────
  const fetchIncomeRecords = async () => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const query = `?search=${revenueSearch}&incomeSource=${revenueSourceFilter}&paymentMethod=${revenueMethodFilter}&startDate=${revenueStartDate}&endDate=${revenueEndDate}&category=${revenueCategoryFilter}&customerName=${revenueCustomerFilter}`;
      const res = await fetch(`${API_URL}/api/income${query}`, { headers });
      if (res.ok) setIncomeRecords(await res.json());
    } catch (err) { console.error('Failed to load income records:', err); }
  };

  const fetchIncomeAnalytics = async () => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const query = `?search=${revenueSearch}&incomeSource=${revenueSourceFilter}&paymentMethod=${revenueMethodFilter}&startDate=${revenueStartDate}&endDate=${revenueEndDate}&category=${revenueCategoryFilter}&customerName=${revenueCustomerFilter}`;
      const res = await fetch(`${API_URL}/api/income/analytics${query}`, { headers });
      if (res.ok) setIncomeAnalytics(await res.json());
    } catch (err) { console.error('Failed to load income analytics:', err); }
  };

  const handleRecordManualIncome = async () => {
    if (!newIncAmount || parseFloat(newIncAmount) <= 0) return alert('Amount must be positive.');
    if (!newIncDescription) return alert('Description is required.');

    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/income`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          amount: parseFloat(newIncAmount),
          paymentMethod: newIncMethod,
          referenceNumber: newIncReference,
          description: newIncDescription
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Income recorded successfully.');
      setNewIncAmount('');
      setNewIncMethod('cash');
      setNewIncReference('');
      setNewIncDescription('');
      setShowManualIncomeModal(false);
      await fetchIncomeRecords();
      await fetchIncomeAnalytics();
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
  };

  // ── 📦 CONSUMABLE STOCK HANDLERS ───────────────────────────────────────
  const fetchConsumables = async () => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/consumables`, { headers });
      if (res.ok) setConsumables(await res.json());
    } catch (err) { console.error('Failed to load consumables list:', err); }
  };

  const fetchConsumableLogs = async (id: number) => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/consumables/${id}/logs`, { headers });
      if (res.ok) setConsumableLogs(await res.json());
    } catch (err) { console.error('Failed to load consumable logs:', err); }
  };

  const handleCreateConsumable = async () => {
    if (!consName) return alert('Name is required.');
    if (consIsMultiUnit) {
      if (!consPackageUnitId) return alert('Big Unit (Package) is required when multi-unit scaling is active.');
      if (!consPieceUnitId) return alert('Small Unit (Piece) is required when multi-unit scaling is active.');
      if (!consPackagePrice) return alert('Package Price is required when multi-unit scaling is active.');
    } else {
      if (!consUnitOfMeasureId) return alert('Base Inventory Unit is required.');
    }

    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      
      const priceOfUnit = consIsMultiUnit 
        ? (consPackagePrice ? parseFloat(consPackagePrice) / consUnitRatio : 0)
        : (consUnitPrice ? parseFloat(consUnitPrice) : 0);

      const res = await fetch(`${API_URL}/api/consumables`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: consName,
          category: consCategory,
          stockQty: consStockQty ? parseInt(consStockQty) : 0,
          restockLevel: consRestockLevel ? parseInt(consRestockLevel) : 0,
          unitPrice: priceOfUnit,
          costPrice: consCostPrice ? parseFloat(consCostPrice) : 0,
          sku: consSku,
          isMultiUnit: consIsMultiUnit,
          packageUnitId: consIsMultiUnit ? consPackageUnitId : null,
          pieceUnitId: consIsMultiUnit ? consPieceUnitId : null,
          unitRatio: consIsMultiUnit ? consUnitRatio : 1,
          packagePrice: consIsMultiUnit ? parseFloat(consPackagePrice) : null,
          unitOfMeasureId: consIsMultiUnit ? consPackageUnitId : consUnitOfMeasureId
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Consumable item registered successfully.');
      setConsName('');
      setConsCategory('general');
      setConsStockQty('');
      setConsRestockLevel('');
      setConsUnitPrice('');
      setConsCostPrice('');
      setConsSku('');
      setConsIsMultiUnit(false);
      setConsPackageUnitId('');
      setConsPieceUnitId('');
      setConsUnitRatio(1);
      setConsPackagePrice('');
      setConsUnitOfMeasureId('');
      setShowConsumableModal(false);
      await fetchConsumables();
    } catch (err: any) { alert(err.message); }
  };

  const handleUseConsumable = async () => {
    if (!selectedConsumable) return;
    if (!consUseQty || parseInt(consUseQty) <= 0) return alert('Quantity must be positive.');

    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/consumables/${selectedConsumable.id}/use`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          quantity: parseInt(consUseQty),
          notes: consUseNotes,
          operator: currentUser?.username || 'staff'
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);

      let uraNote = '';
      if (consUseToUra) {
        const result = await reportStockToUra(
          'decrease',
          selectedConsumable.id,
          parseInt(consUseQty),
          { adjustType: consUseUraType, remarks: consUseNotes },
          `USE-${selectedConsumable.id}-${Date.now()}`
        );
        uraNote = result.ok ? `\n\nURA: ${result.message}` : `\n\nURA reporting failed: ${result.message}`;
      }

      alert('Usage recorded successfully.' + uraNote);
      setConsUseQty('');
      setConsUseNotes('');
      setConsUseToUra(false);
      setShowConsumableUseModal(false);
      setSelectedConsumable(null);
      await fetchConsumables();
    } catch (err: any) { alert(err.message); }
  };

  // Reports one consumable stock movement to URA. Kept separate from the local
  // stock change on purpose: the local record must stand even when URA is
  // unreachable, so a failed report is something to retry, not a lost restock.
  const reportStockToUra = async (
    direction: 'increase' | 'decrease',
    consumableId: number,
    quantity: number,
    extra: Record<string, any>,
    reference: string
  ) => {
    try {
      const res = await fetch(`${API_URL}/api/efris/stock-${direction}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
        body: JSON.stringify({ ...extra, reference, items: [{ consumableId, quantity }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return { ok: true, message: data.message as string };
    } catch (err: any) {
      return { ok: false, message: err.message as string };
    }
  };

  const handleRestockConsumable = async () => {
    if (!selectedConsumable) return;
    if (!consRestockQty || parseInt(consRestockQty) <= 0) return alert('Quantity must be positive.');

    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/consumables/${selectedConsumable.id}/restock`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          quantity: parseInt(consRestockQty),
          costPrice: consRestockCost ? parseFloat(consRestockCost) : undefined,
          notes: consRestockNotes,
          operator: currentUser?.username || 'staff'
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);

      let uraNote = '';
      if (consRestockToUra) {
        const result = await reportStockToUra(
          'increase',
          selectedConsumable.id,
          parseInt(consRestockQty),
          {
            stockInType: consRestockUraType,
            supplierName: consRestockSupplier,
            supplierTin: consRestockSupplierTin,
            productionBatchNo: consRestockBatchNo,
            stockInDate: new Date().toISOString().slice(0, 10),
          },
          `RESTOCK-${selectedConsumable.id}-${Date.now()}`
        );
        uraNote = result.ok ? `\n\nURA: ${result.message}` : `\n\nURA reporting failed: ${result.message}`;
      }

      alert('Replenishment logged successfully.' + uraNote);
      setConsRestockQty('');
      setConsRestockCost('');
      setConsRestockNotes('');
      setConsRestockToUra(false);
      setConsRestockSupplier('');
      setConsRestockSupplierTin('');
      setConsRestockBatchNo('');
      setShowConsumableRestockModal(false);
      setSelectedConsumable(null);
      await fetchConsumables();
    } catch (err: any) { alert(err.message); }
  };

  // ── 🖥️ SYSTEM HEALTH / INCIDENTS BOARD HANDLERS ───────────────────
  const fetchSystemComponents = async () => {
    try {
      const res = await fetch(`${API_URL}/api/system/components`);
      if (res.ok) setSystemComponents(await res.json());
    } catch (err) { console.error('Failed to load system components:', err); }
  };

  const fetchSystemIncidents = async () => {
    try {
      const query = selectedSystemComponent ? `?componentId=${selectedSystemComponent}` : '';
      const res = await fetch(`${API_URL}/api/system/incidents${query}`);
      if (res.ok) setSystemIncidents(await res.json());
    } catch (err) { console.error('Failed to load system incidents:', err); }
  };

  const handleToggleComponentStatus = async (id: number, status: string) => {
    try {
      const res = await fetch(`${API_URL}/api/system/components/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await fetchSystemComponents();
    } catch (err: any) { alert(err.message); }
  };

  const handleLogIncident = async () => {
    if (!incidentComponentId || !incidentTitle || !incidentMessage) return alert('All fields are required.');
    try {
      const res = await fetch(`${API_URL}/api/system/incidents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          componentId: parseInt(incidentComponentId),
          title: incidentTitle,
          severity: incidentSeverity,
          message: incidentMessage,
          reporter: currentUser?.username || 'admin'
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Incident logged successfully.');
      setIncidentComponentId('');
      setIncidentTitle('');
      setIncidentSeverity('info');
      setIncidentMessage('');
      setShowIncidentModal(false);
      await fetchSystemIncidents();
    } catch (err: any) { alert(err.message); }
  };

  const handleResolveIncident = async (id: number) => {
    try {
      const res = await fetch(`${API_URL}/api/system/incidents/${id}/resolve`, {
        method: 'PATCH'
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await fetchSystemIncidents();
    } catch (err: any) { alert(err.message); }
  };

  // ── ❓ HELP CENTER / KNOWLEDGE DATABASE HANDLERS ──────────────────────
  const fetchHelpCategories = async () => {
    try {
      const res = await fetch(`${API_URL}/api/help/categories`);
      if (res.ok) setHelpCategories(await res.json());
    } catch (err) { console.error('Failed to load help categories:', err); }
  };

  const fetchHelpArticles = async () => {
    try {
      const query = `?categoryId=${selectedHelpCategory || ''}&search=${helpSearch}`;
      const res = await fetch(`${API_URL}/api/help/articles${query}`);
      if (res.ok) setHelpArticles(await res.json());
    } catch (err) { console.error('Failed to load help articles:', err); }
  };

  const fetchHelpFaqs = async () => {
    try {
      const res = await fetch(`${API_URL}/api/help/faqs`);
      if (res.ok) setHelpFaqs(await res.json());
    } catch (err) { console.error('Failed to load FAQs:', err); }
  };

  // ── Midway Support Desk ──────────────────────────────────────────────────
  // Everything below talks to OUR server, which proxies the Midway desk — the
  // channel API key never reaches the browser.

  const fetchSupportStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/support/status`);
      if (res.ok) setSupportConfigured((await res.json()).configured === true);
    } catch { /* support is optional — stay hidden on failure */ }
  };

  const fetchSupportTickets = async () => {
    try {
      const res = await fetch(`${API_URL}/api/support/tickets`);
      if (res.ok) setSupportTickets((await res.json()).tickets || []);
    } catch (err) { console.error('Failed to load support requests:', err); }
  };

  const handleSupportKbSearch = async () => {
    const q = supportKbQuery.trim();
    if (!q) { setSupportKbResults(null); return; }
    try {
      const res = await fetch(`${API_URL}/api/support/kb?q=${encodeURIComponent(q)}`);
      setSupportKbResults(res.ok ? ((await res.json()).articles || []) : []);
    } catch { setSupportKbResults([]); }
  };

  const handleSubmitSupportTicket = async () => {
    if (!supportSubject.trim() || !supportDescription.trim()) {
      setSupportNotice({ kind: 'err', text: 'Please fill in both a subject and a description.' });
      return;
    }
    setSupportSubmitting(true);
    setSupportNotice(null);
    try {
      const res = await fetch(`${API_URL}/api/support/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: supportSubject.trim(),
          description: supportDescription.trim(),
          priority: supportPriority,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSupportNotice({ kind: 'err', text: data.error || 'Could not send your request. Please try again.' });
      } else {
        // Show the desk's own acknowledgment — it carries the reference number.
        setSupportNotice({ kind: 'ok', text: data.autoReply || `Request ${data.ticketRef} received.` });
        setSupportSubject('');
        setSupportDescription('');
        setSupportPriority('NORMAL');
        await fetchSupportTickets();
      }
    } catch {
      setSupportNotice({ kind: 'err', text: 'Could not reach the support desk. Check your connection and try again.' });
    } finally {
      setSupportSubmitting(false);
    }
  };

  const openSupportThread = async (ref: string) => {
    // Clicking the open request again collapses it.
    if (supportOpenRef === ref) { setSupportOpenRef(null); setSupportThread(null); return; }
    setSupportOpenRef(ref);
    setSupportThread(null);
    setSupportReply('');
    setSupportThreadLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/support/tickets/${encodeURIComponent(ref)}`);
      if (res.ok) {
        setSupportThread(await res.json());
        // The server refreshes its cached status on read — mirror that in the list.
        await fetchSupportTickets();
      }
    } catch (err) { console.error('Failed to load support thread:', err); }
    finally { setSupportThreadLoading(false); }
  };

  const handleSendSupportReply = async () => {
    if (!supportOpenRef || !supportReply.trim()) return;
    const body = supportReply.trim();
    setSupportReply('');
    try {
      const res = await fetch(`${API_URL}/api/support/tickets/${encodeURIComponent(supportOpenRef)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSupportNotice({ kind: 'err', text: data.error || 'Could not send your reply.' });
        setSupportReply(body); // hand the text back so it isn't lost
        return;
      }
      // Re-fetch so the new message renders from the desk's authoritative copy.
      const refreshed = await fetch(`${API_URL}/api/support/tickets/${encodeURIComponent(supportOpenRef)}`);
      if (refreshed.ok) setSupportThread(await refreshed.json());
      await fetchSupportTickets();
    } catch {
      setSupportNotice({ kind: 'err', text: 'Could not reach the support desk.' });
      setSupportReply(body);
    }
  };

  const handleViewArticle = async (id: number) => {
    try {
      const res = await fetch(`${API_URL}/api/help/articles/${id}`);
      if (res.ok) setSelectedArticle(await res.json());
    } catch (err) { console.error('Failed to load article details:', err); }
  };

  // ── 🔧 ASSET MAINTENANCE HANDLERS ────────────────────────────────────
  const handleOpenAssetMaintenance = async (asset: any) => {
    setSelectedAssetForMaintenance(asset);
    setMaintTitle('');
    setMaintDescription('');
    setMaintStartTime('');
    setMaintEndTime('');
    setMaintStatus('Scheduled');
    setMaintCost('');
    setMaintNotes('');
    await fetchMaintenanceLogs(asset.id);
    setShowMaintenanceModal(true);
  };

  const fetchMaintenanceLogs = async (assetId: number) => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/serialized-assets/${assetId}/maintenance`, { headers });
      if (!res.ok) throw new Error('Failed to load maintenance logs.');
      setMaintenanceEvents(await res.json());
    } catch (err: any) { alert(err.message); }
  };

  const handleScheduleMaintenance = async () => {
    if (!selectedAssetForMaintenance) return;
    if (!maintTitle || !maintStartTime || !maintEndTime) return alert('Title, start time, and end time are required.');

    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/serialized-assets/${selectedAssetForMaintenance.id}/maintenance`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: maintTitle,
          description: maintDescription,
          startTime: maintStartTime,
          endTime: maintEndTime,
          status: maintStatus,
          cost: maintCost ? parseFloat(maintCost) : 0,
          notes: maintNotes
        })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to schedule maintenance.');
      alert('Maintenance event scheduled successfully.');
      setMaintTitle('');
      setMaintDescription('');
      setMaintStartTime('');
      setMaintEndTime('');
      setMaintStatus('Scheduled');
      setMaintCost('');
      setMaintNotes('');
      await fetchMaintenanceLogs(selectedAssetForMaintenance.id);
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
  };

  const handleCompleteMaintenance = async (eventId: number) => {
    const costInput = prompt('Enter final repair/maintenance cost (or leave empty):', '0') ?? '0';
    const notesInput = prompt('Enter completion notes (optional):') ?? '';
    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/maintenance-events/${eventId}/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cost: parseFloat(costInput) || 0,
          notes: notesInput
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Maintenance event completed. Asset is now Available.');
      if (selectedAssetForMaintenance) {
        await fetchMaintenanceLogs(selectedAssetForMaintenance.id);
      }
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
  };

  // ── 📅 EVENT RESERVATIONS COCKPIT HANDLERS ───────────────────────────
  const fetchFunctionDetails = async (func: any) => {
    setSelectedFunctionEvent(func);
    setActiveFunctionTab('staffing');
    setReserveType('item');
    setReserveItemId('');
    setReserveAssetId('');
    setReserveQuantity('1');
    setReserveNotes('');
    setNewChecklistText('');
    setNewIssueTitle('');
    setNewIssueDescription('');
    setNewIssueSeverity('Medium');
    setNewTimelineDescription('');

    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      
      // Load Reservations
      const itemsRes = await fetch(`${API_URL}/api/functions/${func.id}/items`, { headers });
      if (itemsRes.ok) setFunctionItems(await itemsRes.json());

      // Load Checklist
      const chkRes = await fetch(`${API_URL}/api/functions/${func.id}/checklist`, { headers });
      if (chkRes.ok) setFunctionChecklist(await chkRes.json());

      // Load Issues
      const issRes = await fetch(`${API_URL}/api/functions/${func.id}/issues`, { headers });
      if (issRes.ok) setFunctionIssues(await issRes.json());

      // Load Activities
      const actRes = await fetch(`${API_URL}/api/functions/${func.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());

      // Load Expenses + Signatures (Financials tab)
      const expRes = await fetch(`${API_URL}/api/functions/${func.id}/expenses`, { headers });
      if (expRes.ok) setFunctionExpenses(await expRes.json());
      const sigRes = await fetch(`${API_URL}/api/functions/${func.id}/signatures`, { headers });
      if (sigRes.ok) setFunctionSignatures(await sigRes.json());

      setFxExpType('other'); setFxExpDesc(''); setFxExpAmt(''); setFxExpDate(new Date().toISOString().split('T')[0]); setFxExpReceipt('');
      setNewRevAmount(''); setNewRevMethod('cash'); setNewRevRef(''); setNewRevNotes('');
      setCompletionNotesInput(func.completionNotes || '');

      setShowFunctionDrawer(true);
    } catch (err: any) { alert(err.message); }
  };

  const refreshFunctionFinancials = async () => {
    if (!selectedFunctionEvent) return;
    const headers = { 'x-company-id': selectedCompanyId.toString() };
    const expRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/expenses`, { headers });
    if (expRes.ok) setFunctionExpenses(await expRes.json());
    // Refresh the function itself so totalRevenue/totalExpenses/status reflect the latest state.
    const funcRes = await fetch(`${API_URL}/api/functions`, { headers });
    if (funcRes.ok) {
      const list = await funcRes.json();
      const updated = list.find((f: any) => f.id === selectedFunctionEvent.id);
      if (updated) setSelectedFunctionEvent(updated);
    }
    const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
    if (actRes.ok) setFunctionActivities(await actRes.json());
    await fetchAllData();
  };

  const handleAddFunctionExpense = async () => {
    if (!selectedFunctionEvent) return;
    if (!fxExpDesc || !fxExpAmt || !fxExpDate) return alert('Description, amount, and date are required.');
    try {
      const res = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': selectedCompanyId.toString() },
        body: JSON.stringify({ expenseType: fxExpType, description: fxExpDesc, amount: fxExpAmt, expenseDate: fxExpDate, receiptNumber: fxExpReceipt || undefined })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setFxExpDesc(''); setFxExpAmt(''); setFxExpReceipt('');
      await refreshFunctionFinancials();
    } catch (err: any) { alert(err.message); }
  };

  const handleDeleteFunctionExpense = async (id: number) => {
    if (!confirm('Remove this expense?')) return;
    try {
      const res = await fetch(`${API_URL}/api/function-expenses/${id}`, { method: 'DELETE', headers: { 'x-company-id': selectedCompanyId.toString() } });
      if (!res.ok) throw new Error((await res.json()).error);
      await refreshFunctionFinancials();
    } catch (err: any) { alert(err.message); }
  };

  const handleRecordFunctionRevenue = async () => {
    if (!selectedFunctionEvent) return;
    if (!newRevAmount || Number(newRevAmount) <= 0) return alert('Enter a valid amount.');
    try {
      const res = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/revenue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': selectedCompanyId.toString() },
        body: JSON.stringify({ amount: newRevAmount, paymentMethod: newRevMethod, referenceNumber: newRevRef || undefined, notes: newRevNotes || undefined })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setNewRevAmount(''); setNewRevRef(''); setNewRevNotes('');
      await refreshFunctionFinancials();
      alert('Revenue recorded.');
    } catch (err: any) { alert(err.message); }
  };

  const handleCompleteFunction = async () => {
    if (!selectedFunctionEvent) return;
    try {
      const res = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': selectedCompanyId.toString() },
        body: JSON.stringify({ completionNotes: completionNotesInput })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setShowCompleteFunctionModal(false);
      await refreshFunctionFinancials();
    } catch (err: any) { alert(err.message); }
  };

  const handleSaveSignature = async (dataUrl: string) => {
    if (!selectedFunctionEvent) return;
    if (!signeeName) return alert('Signee name is required.');
    try {
      const res = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/signatures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': selectedCompanyId.toString() },
        body: JSON.stringify({ signatureType, signeeName, signeeContact: signeeContact || undefined, signatureData: dataUrl })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setShowSignatureModal(false);
      setSigneeName(''); setSigneeContact('');
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const sigRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/signatures`, { headers });
      if (sigRes.ok) setFunctionSignatures(await sigRes.json());
      const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());
    } catch (err: any) { alert(err.message); }
  };

  // ── Function templates ──
  const fetchFunctionTemplates = async () => {
    try {
      const res = await fetch(`${API_URL}/api/function-templates`, { headers: { 'x-company-id': selectedCompanyId.toString() } });
      if (res.ok) setFunctionTemplates(await res.json());
    } catch { /* ignore */ }
  };

  const handleCreateTemplate = async () => {
    if (!newTemplateName) return alert('Template name is required.');
    try {
      const res = await fetch(`${API_URL}/api/function-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': selectedCompanyId.toString() },
        body: JSON.stringify({ name: newTemplateName, description: newTemplateDesc || undefined })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setNewTemplateName(''); setNewTemplateDesc('');
      setShowCreateTemplateModal(false);
      await fetchFunctionTemplates();
    } catch (err: any) { alert(err.message); }
  };

  const handleDeleteTemplate = async (id: number) => {
    if (!confirm('Delete this template?')) return;
    try {
      await fetch(`${API_URL}/api/function-templates/${id}`, { method: 'DELETE', headers: { 'x-company-id': selectedCompanyId.toString() } });
      await fetchFunctionTemplates();
    } catch (err: any) { alert(err.message); }
  };

  const handleAddTemplateItem = async (templateId: number, itemType: string, refId: string, quantity: string) => {
    if (!refId) return alert('Select an item or asset.');
    try {
      const res = await fetch(`${API_URL}/api/function-templates/${templateId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': selectedCompanyId.toString() },
        body: JSON.stringify({ itemType, itemId: itemType === 'item' ? refId : undefined, assetId: itemType === 'asset' ? refId : undefined, quantity })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await fetchFunctionTemplates();
    } catch (err: any) { alert(err.message); }
  };

  const handleDeleteTemplateItem = async (id: number) => {
    try {
      await fetch(`${API_URL}/api/function-template-items/${id}`, { method: 'DELETE', headers: { 'x-company-id': selectedCompanyId.toString() } });
      await fetchFunctionTemplates();
    } catch (err: any) { alert(err.message); }
  };

  const handleCreateFunctionFromTemplate = async (templateId: number, form: { name: string; date: string; clientName: string; clientContact: string; location?: string; time?: string }) => {
    try {
      const res = await fetch(`${API_URL}/api/function-templates/${templateId}/create-function`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': selectedCompanyId.toString() },
        body: JSON.stringify(form)
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setShowTemplatesModal(false);
      setCreateFromTemplateId(null);
      await fetchAllData();
      alert('Function created from template.');
    } catch (err: any) { alert(err.message); }
  };

  const handleReserveItem = async () => {
    if (!selectedFunctionEvent) return;
    if (reserveType === 'item' && !reserveItemId) return alert('Please select an item.');
    if (reserveType === 'asset' && !reserveAssetId) return alert('Please select a serialized asset.');
    if (reserveType === 'consumable' && !reserveConsumableId) return alert('Please select a consumable.');

    try {
       const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/items`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          itemType: reserveType,
          itemId: reserveType === 'item' ? parseInt(reserveItemId) : undefined,
          assetId: reserveType === 'asset' ? parseInt(reserveAssetId) : undefined,
          consumableId: reserveType === 'consumable' ? parseInt(reserveConsumableId) : undefined,
          unitOfMeasureId: (reserveType === 'consumable' && reserveUomId) ? parseInt(reserveUomId) : undefined,
          quantity: reserveType === 'asset' ? 1 : parseInt(reserveQuantity) || 1,
          notes: reserveNotes
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reserve item.');
      alert('Equipment reserved successfully.');
      setReserveItemId('');
      setReserveAssetId('');
      setReserveConsumableId('');
      setReserveUomId('');
      setReserveQuantity('1');
      setReserveNotes('');
      
      // Refresh reservations & timeline
      const itemsRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/items`, { headers });
      if (itemsRes.ok) setFunctionItems(await itemsRes.json());
      const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
  };

  const handleCancelReservation = async (assignId: number) => {
    if (!selectedFunctionEvent) return;
    if (!confirm('Are you sure you want to cancel this reservation?')) return;
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/function-items/${assignId}`, {
        method: 'DELETE',
        headers
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Reservation cancelled.');

      // Refresh
      const itemsRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/items`, { headers });
      if (itemsRes.ok) setFunctionItems(await itemsRes.json());
      const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
  };

  const handleDispatchReservation = async (assignId: number) => {
    if (!selectedFunctionEvent) return;
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/function-items/${assignId}/dispatch`, {
        method: 'POST',
        headers
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Equipment dispatched.');

      // Refresh
      const itemsRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/items`, { headers });
      if (itemsRes.ok) setFunctionItems(await itemsRes.json());
      const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
  };

  const handleReturnReservation = async (assignId: number) => {
    if (!selectedFunctionEvent) return;
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/function-items/${assignId}/return`, {
        method: 'POST',
        headers
      });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('Equipment marked as returned.');

      // Refresh
      const itemsRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/items`, { headers });
      if (itemsRes.ok) setFunctionItems(await itemsRes.json());
      const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());
      await fetchAllData();
    } catch (err: any) { alert(err.message); }
  };

  const handleCreateChecklistItem = async () => {
    if (!selectedFunctionEvent || !newChecklistText) return;
    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/checklist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ 
          itemText: newChecklistText,
          assignedEmployeeId: checklistAssigneeId ? parseInt(checklistAssigneeId) : undefined
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setNewChecklistText('');
      setChecklistAssigneeId('');

      const chkRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/checklist`, { headers });
      if (chkRes.ok) setFunctionChecklist(await chkRes.json());
    } catch (err: any) { alert(err.message); }
  };

  const handleToggleChecklistItem = async (itemId: number, currentCompleted: boolean) => {
    if (!selectedFunctionEvent) return;
    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/checklist-items/${itemId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ isCompleted: !currentCompleted })
      });
      if (!res.ok) throw new Error((await res.json()).error);

      const chkRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/checklist`, { headers });
      if (chkRes.ok) setFunctionChecklist(await chkRes.json());
    } catch (err: any) { alert(err.message); }
  };

  const handlePrintBEO = () => {
    if (!selectedFunctionEvent) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert('Please allow popups to print the BEO.');

    const name = selectedFunctionEvent.name;
    const date = selectedFunctionEvent.date;
    const time = selectedFunctionEvent.time;
    const location = selectedFunctionEvent.location;
    const clientName = selectedFunctionEvent.clientName;
    const clientContact = selectedFunctionEvent.clientContact;
    const notes = selectedFunctionEvent.notes || 'None';
    const status = selectedFunctionEvent.status;

    // Roster rows
    const rosterHtml = (selectedFunctionEvent.functionAssignments || []).map((asn: any) => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${asn.role?.name || 'Staff'}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">${asn.employee?.name || 'Unassigned'}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-transform: uppercase; font-size: 10px;">${asn.status || 'Assigned'}</td>
      </tr>
    `).join('') || '<tr><td colspan="3" style="padding: 12px; text-align: center; color: #666;">No staff rostered yet.</td></tr>';

    // Equipment rows
    const equipmentHtml = functionItems.map((assign: any) => {
      const itemName = assign.item?.name || assign.asset?.name || assign.consumable?.name || '';
      const typeLabel = assign.itemType === 'asset' ? 'Serialized Asset' : assign.itemType === 'consumable' ? 'Consumable' : 'Standard Item';
      const uomLabel = assign.unitOfMeasure?.abbreviation || (assign.itemType === 'asset' ? 'unit' : 'pcs');
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">${itemName}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${typeLabel}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-family: monospace; text-align: center;">${assign.quantity} ${uomLabel}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-transform: uppercase; font-size: 10px; text-align: center;">${assign.status}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-size: 11px;">${assign.notes || '—'}</td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="5" style="padding: 12px; text-align: center; color: #666;">No equipment allocated.</td></tr>';

    // Checklist rows
    const checklistHtml = functionChecklist.map((item: any) => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">
          <span style="${item.isCompleted ? 'text-decoration: line-through; color: #888;' : ''}">${item.itemText}</span>
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">${item.assignedEmployee?.name || 'Unassigned'}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center; font-size: 11px;">
          ${item.isCompleted ? '✅ Completed' : '⏳ Pending'}
        </td>
      </tr>
    `).join('') || '<tr><td colspan="3" style="padding: 12px; text-align: center; color: #666;">No checklist tasks.</td></tr>';

    printWindow.document.write(`
      <html>
        <head>
          <title>BEO - ${name}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #333; margin: 40px; line-height: 1.4; }
            .header { text-align: center; border-bottom: 3px double #333; padding-bottom: 15px; margin-bottom: 30px; }
            .header h1 { margin: 0; font-size: 24px; letter-spacing: 1px; text-transform: uppercase; }
            .header p { margin: 5px 0 0 0; font-size: 12px; color: #666; font-weight: bold; }
            .grid { display: flex; justify-content: space-between; margin-bottom: 30px; gap: 40px; }
            .col { flex: 1; }
            .col table { width: 100%; border-collapse: collapse; }
            .col td { padding: 4px 0; font-size: 13px; }
            .col td.label { font-weight: bold; color: #555; width: 120px; }
            .section { margin-bottom: 30px; page-break-inside: avoid; }
            .section-title { font-size: 14px; font-weight: bold; text-transform: uppercase; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 12px; letter-spacing: 0.5px; }
            .data-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
            .data-table th { background: #f5f5f5; padding: 8px; font-weight: bold; border-bottom: 2px solid #333; text-transform: uppercase; font-size: 10px; }
            .notes-box { border: 1px solid #ddd; padding: 12px; font-size: 12px; background: #fafafa; border-radius: 4px; min-height: 60px; }
            @media print {
              body { margin: 20px; }
              button { display: none; }
            }
          </style>
        </head>
        <body>
          <div style="text-align: right; margin-bottom: 20px;">
            <button onclick="window.print()" style="padding: 8px 16px; background: #2563eb; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer;">🖨️ Print Order</button>
          </div>
          <div class="header">
            <h1>Banquet Event Order (BEO)</h1>
            <p>OPERATIONAL DIRECTIVE & ROADMAP</p>
          </div>
          <div class="grid">
            <div class="col">
              <table>
                <tr><td class="label">Event Name:</td><td style="font-weight: bold;">${name}</td></tr>
                <tr><td class="label">Ceremony Date:</td><td>${date}</td></tr>
                <tr><td class="label">Start Time:</td><td>${time}</td></tr>
                <tr><td class="label">Location:</td><td>${location}</td></tr>
                <tr><td class="label">Event Status:</td><td style="font-weight: bold; text-transform: uppercase;">${status}</td></tr>
              </table>
            </div>
            <div class="col">
              <table>
                <tr><td class="label">Client Name:</td><td style="font-weight: bold;">${clientName}</td></tr>
                <tr><td class="label">Client Contact:</td><td>${clientContact}</td></tr>
                <tr><td class="label">Order Date:</td><td>${new Date().toLocaleDateString()}</td></tr>
                <tr><td class="label">BEO Ref ID:</td><td style="font-family: monospace;">BEO-${selectedFunctionEvent.id}-${Math.floor(1000 + Math.random() * 9000)}</td></tr>
              </table>
            </div>
          </div>

          <div class="section">
            <div class="section-title">1. Staff & Roster Assignments</div>
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width: 35%;">Roster Role</th>
                  <th style="width: 45%;">Employee Name</th>
                  <th style="width: 20%;">Roster Status</th>
                </tr>
              </thead>
              <tbody>
                ${rosterHtml}
              </tbody>
            </table>
          </div>

          <div class="section">
            <div class="section-title">2. Equipment & Consumables Load-Out</div>
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width: 30%;">Item/Asset Name</th>
                  <th style="width: 15%;">Type</th>
                  <th style="width: 15%; text-align: center;">Allocation</th>
                  <th style="width: 15%; text-align: center;">Status</th>
                  <th style="width: 25%;">Logistics Notes</th>
                </tr>
              </thead>
              <tbody>
                ${equipmentHtml}
              </tbody>
            </table>
          </div>

          <div class="section">
            <div class="section-title">3. Action Checklist & Assignees</div>
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width: 50%;">Task Description</th>
                  <th style="width: 30%;">Assigned To</th>
                  <th style="width: 20%; text-align: center;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${checklistHtml}
              </tbody>
            </table>
          </div>

          <div class="section">
            <div class="section-title">4. Special Instructions & Event Notes</div>
            <div class="notes-box">
              ${notes.replace(/\n/g, '<br/>')}
            </div>
          </div>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handleCreateFunctionIssue = async () => {
    if (!selectedFunctionEvent) return;
    if (!newIssueTitle || !newIssueDescription) return alert('Title and description are required.');
    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: newIssueTitle, description: newIssueDescription, severity: newIssueSeverity })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setNewIssueTitle('');
      setNewIssueDescription('');
      
      const issRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/issues`, { headers });
      if (issRes.ok) setFunctionIssues(await issRes.json());
      const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());
    } catch (err: any) { alert(err.message); }
  };

  const handleUpdateIssueStatus = async (issueId: number, status: string) => {
    if (!selectedFunctionEvent) return;
    const resNotes = prompt(`Enter resolution / update notes for status "${status}":`) ?? '';
    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/issues/${issueId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ status, resolutionNotes: resNotes })
      });
      if (!res.ok) throw new Error((await res.json()).error);

      const issRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/issues`, { headers });
      if (issRes.ok) setFunctionIssues(await issRes.json());
      const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());
    } catch (err: any) { alert(err.message); }
  };

  const handleCreateTimelineActivity = async () => {
    if (!selectedFunctionEvent || !newTimelineDescription) return;
    try {
      const headers = {
        'x-company-id': selectedCompanyId.toString(),
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ description: newTimelineDescription })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setNewTimelineDescription('');

      const actRes = await fetch(`${API_URL}/api/functions/${selectedFunctionEvent.id}/activities`, { headers });
      if (actRes.ok) setFunctionActivities(await actRes.json());
    } catch (err: any) { alert(err.message); }
  };

  // ── STAFF & SCHEDULING HANDLERS ──────────────────────────────────────
  const handleCreateEmployee = async () => {
    if (!newEmpName) return alert('Name is required');
    try {
      const res = await fetch(`${API_URL}/api/employees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: newEmpName,
          role: newEmpRole,
          billingRateToClient: newEmpBillingRate,
          payStructure: newEmpPayStructure,
          payRate: newEmpPayRate
        })
      });
      if (res.ok) {
        setShowEmployeeModal(false);
        setNewEmpName('');
        setNewEmpRole('');
        setNewEmpBillingRate(0);
        setNewEmpPayRate(0);
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add employee');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateSite = async () => {
    if (!newSiteName) return alert('Site name is required');
    try {
      const res = await fetch(`${API_URL}/api/sites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: newSiteName,
          location: newSiteLocation,
          contactPerson: newSiteContactPerson,
          contactInfo: newSiteContactInfo,
          notes: newSiteNotes
        })
      });
      if (res.ok) {
        setShowSiteModal(false);
        setNewSiteName('');
        setNewSiteLocation('');
        setNewSiteContactPerson('');
        setNewSiteContactInfo('');
        setNewSiteNotes('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add site');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAssignSite = async () => {
    if (!assignSiteId || !assignSiteEmployeeId) return alert('Site and employee are required');
    try {
      const res = await fetch(`${API_URL}/api/sites/${assignSiteId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          employeeId: parseInt(assignSiteEmployeeId),
          isPrimary: assignSiteIsPrimary,
          notes: assignSiteNotes
        })
      });
      if (res.ok) {
        setShowAssignSiteModal(false);
        setAssignSiteId(null);
        setAssignSiteEmployeeId('');
        setAssignSiteIsPrimary(false);
        setAssignSiteNotes('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to assign employee to site');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateEvent = async () => {
    if (!newEventName || !newEventDate || !newEventLocation) return alert('Name, Date, and Location are required');
    try {
      const res = await fetch(`${API_URL}/api/functions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: newEventName,
          date: newEventDate,
          time: newEventTime,
          location: newEventLocation,
          clientName: newEventClientName,
          clientContact: newEventClientContact,
          notes: newEventNotes
        })
      });
      if (res.ok) {
        setShowEventModal(false);
        setNewEventName('');
        setNewEventDate('');
        setNewEventTime('');
        setNewEventLocation('');
        setNewEventClientName('');
        setNewEventClientContact('');
        setNewEventNotes('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create event');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAssignStaff = async () => {
    if (!assignEventId || !assignEmployeeId || !assignRoleId) return alert('Event, Employee, and Role are required');
    try {
      const res = await fetch(`${API_URL}/api/functions/${assignEventId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          employeeId: parseInt(assignEmployeeId),
          roleId: parseInt(assignRoleId),
          startTime: assignStartTime,
          endTime: assignEndTime,
          notes: assignNotes
        })
      });
      if (res.ok) {
        setShowAssignStaffModal(false);
        setAssignEventId(null);
        setAssignEmployeeId('');
        setAssignRoleId('');
        setAssignStartTime('');
        setAssignEndTime('');
        setAssignNotes('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to assign staff');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // ── BOOKKEEPING & LEDGER HANDLERS ──────────────────────────────────────
  const handleCreateSupplier = async () => {
    if (!newSupplierName) return alert('Supplier name is required');
    try {
      const res = await fetch(`${API_URL}/api/suppliers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: newSupplierName,
          contactPerson: newSupplierPerson,
          phone: newSupplierPhone,
          email: newSupplierEmail,
          address: newSupplierAddress,
          notes: newSupplierNotes
        })
      });
      if (res.ok) {
        setShowSupplierModal(false);
        setNewSupplierName('');
        setNewSupplierPerson('');
        setNewSupplierPhone('');
        setNewSupplierEmail('');
        setNewSupplierAddress('');
        setNewSupplierNotes('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add supplier');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreatePO = async () => {
    if (!newPOSupplierId || !newPONumber || !newPODate || newPOLineItems.length === 0) {
      return alert('Supplier, PO Number, Date, and at least one item are required');
    }
    try {
      const res = await fetch(`${API_URL}/api/purchase-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          supplierId: parseInt(newPOSupplierId),
          poNumber: newPONumber,
          orderDate: newPODate,
          deliveryDate: newPODeliveryDate,
          notes: newPONotes,
          lineItems: newPOLineItems
        })
      });
      if (res.ok) {
        setShowPOModal(false);
        setNewPOSupplierId('');
        setNewPONumber('');
        setNewPODate('');
        setNewPODeliveryDate('');
        setNewPONotes('');
        setNewPOLineItems([]);
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create PO');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdatePOStatus = async (poId: number, status: string) => {
    try {
      const res = await fetch(`${API_URL}/api/purchase-orders/${poId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to update PO status');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateExpense = async () => {
    if (!newExpAmount || !newExpCategory || !newExpDate || !newExpPaymentMethod) {
      return alert('Amount, Category, Date, and Payment Method are required');
    }
    try {
      const res = await fetch(`${API_URL}/api/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          supplierId: newExpSupplierId ? parseInt(newExpSupplierId) : null,
          amount: newExpAmount,
          expenseCategory: newExpCategory,
          expenseDate: newExpDate,
          paymentMethod: newExpPaymentMethod,
          notes: newExpNotes
        })
      });
      if (res.ok) {
        setShowExpenseModal(false);
        setNewExpSupplierId('');
        setNewExpAmount(0);
        setNewExpCategory('Fuel');
        setNewExpDate('');
        setNewExpPaymentMethod('Cash');
        setNewExpNotes('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to log expense');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreatePayrollPeriod = async () => {
    if (!newPayrollStart || !newPayrollEnd) return alert('Start Date and End Date are required');
    try {
      const res = await fetch(`${API_URL}/api/payroll-periods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          startDate: newPayrollStart,
          endDate: newPayrollEnd
        })
      });
      if (res.ok) {
        setShowPayrollPeriodModal(false);
        setNewPayrollStart('');
        setNewPayrollEnd('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create payroll period');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handlePayEmployee = async () => {
    if (!payEmployeePaymentId || !payEmployeeMethod || !payEmployeeDate) {
      return alert('Payment Method and Date are required');
    }
    try {
      const res = await fetch(`${API_URL}/api/payroll-payments/${payEmployeePaymentId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentMethod: payEmployeeMethod,
          paymentDate: payEmployeeDate,
          notes: payEmployeeNotes
        })
      });
      if (res.ok) {
        setShowPayEmployeeModal(false);
        setPayEmployeePaymentId(null);
        setPayEmployeeMethod('Cash');
        setPayEmployeeDate('');
        setPayEmployeeNotes('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to pay employee');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdatePayrollPeriodStatus = async (periodId: number, status: string) => {
    try {
      const res = await fetch(`${API_URL}/api/payroll-periods/${periodId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to update payroll status');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handlePayInvoice = async () => {
    if (!payInvoiceId || !payInvoiceMethod || !payInvoiceDate) {
      return alert('Payment Method and Date are required');
    }
    // One key per payment attempt: a retry or double-click reuses it, so the
    // server recognises the replay and never posts the payment twice.
    if (!__pendingPaymentKey || __pendingPaymentKeyInvoice !== payInvoiceId) {
      __pendingPaymentKey = (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      __pendingPaymentKeyInvoice = payInvoiceId;
    }
    try {
      const res = await fetch(`${API_URL}/api/invoices/${payInvoiceId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentKey: __pendingPaymentKey,
          paymentMethod: payInvoiceMethod,
          paymentDate: payInvoiceDate,
          notes: payInvoiceNotes,
          ...(payInvoiceAmount.trim() ? { amount: Number(payInvoiceAmount) } : {})
        })
      });
      if (res.ok) {
        __pendingPaymentKey = '';
        setShowPayInvoiceModal(false);
        setPayInvoiceId(null);
        setPayInvoiceMethod('Cash');
        setPayInvoiceDate('');
        setPayInvoiceNotes('');
        setPayInvoiceAmount('');
        await fetchAllData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to record invoice payment');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleExportCSV = async (target: 'customers' | 'items' | 'assets' | 'consumables' | 'employees') => {
    try {
      const headers = { 'x-company-id': selectedCompanyId.toString() };
      const res = await fetch(`${API_URL}/api/export/${target}`, { headers });
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${target}-export.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        alert(`Failed to export ${target} CSV`);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Download a CSV report from a full path (may include query filters).
  const downloadCsv = async (path: string, filename: string) => {
    try {
      const res = await fetch(`${API_URL}${path}`, { headers: { 'x-company-id': selectedCompanyId.toString() } });
      if (!res.ok) return alert('Failed to export report.');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleExportRevenue = () => {
    const q = `?search=${encodeURIComponent(revenueSearch)}&incomeSource=${revenueSourceFilter}&paymentMethod=${revenueMethodFilter}&startDate=${revenueStartDate}&endDate=${revenueEndDate}&category=${revenueCategoryFilter}&customerName=${encodeURIComponent(revenueCustomerFilter)}`;
    downloadCsv(`/api/export/income${q}`, 'revenue-report.csv');
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
      if (lines.length < 2) {
        return alert('The CSV file does not contain enough data.');
      }

      // Header parsing
      const headers = lines[0].split(',').map(h => h.replace(/^["']|["']$/g, '').trim());
      const parsedData: any[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const row: string[] = [];
        let inQuotes = false;
        let startIdx = 0;

        for (let j = 0; j < line.length; j++) {
          if (line[j] === '"') {
            inQuotes = !inQuotes;
          } else if (line[j] === ',' && !inQuotes) {
            row.push(line.substring(startIdx, j).replace(/^["']|["']$/g, '').replace(/""/g, '"').trim());
            startIdx = j + 1;
          }
        }
        row.push(line.substring(startIdx).replace(/^["']|["']$/g, '').replace(/""/g, '"').trim());

        const obj: any = {};
        headers.forEach((h, idx) => {
          if (row[idx] !== undefined) {
            obj[h] = row[idx];
          }
        });
        parsedData.push(obj);
      }

      // Send to server
      try {
        const companyHeaders = { 
          'Content-Type': 'application/json',
          'x-company-id': selectedCompanyId.toString()
        };
        const res = await fetch(`${API_URL}/api/import/${importTarget}`, {
          method: 'POST',
          headers: companyHeaders,
          body: JSON.stringify({ data: parsedData })
        });

        if (res.ok) {
          setShowImportModal(false);
          alert(`Successfully imported ${parsedData.length} records!`);
          await fetchAllData();
        } else {
          const errData = await res.json();
          alert(errData.error || 'Failed to import data');
        }
      } catch (err: any) {
        alert(err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleLogin = async () => {
    if (!loginUsername || !loginPassword) return alert('Username and password are required.');
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword })
      });
      if (res.ok) {
        const data = await res.json();
        setSessionToken(data.sessionToken); // set synchronously so first data load is authenticated
        setCurrentUser(data);
        if (data.company) setSelectedCompanyId(data.company.id);
        localStorage.setItem('yourhires_user', JSON.stringify(data));
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to authenticate.');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleLogout = () => {
    // Best-effort server-side session invalidation.
    fetch(`${API_URL}/api/auth/logout`, { method: 'POST', headers: { 'x-company-id': String(selectedCompanyId) } }).catch(() => {});
    setSessionToken('');
    setCurrentUser(null);
    localStorage.removeItem('yourhires_user');
  };

  const handleForgotPassword = async () => {
    if (!forgotEmail) return alert('Enter your account email.');
    setAuthBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/forgot-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail })
      });
      const data = await res.json();
      setForgotMsg(data.message || 'If that email is registered, a reset link has been sent.');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleResetPassword = async () => {
    if (resetPassword.length < 8) return alert('Password must be at least 8 characters.');
    setAuthBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/reset-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: resetPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reset failed');
      setResetMsg(data.message || 'Password reset. You can now sign in.');
      setResetPassword('');
      // Clear the token from the URL so a refresh doesn't reuse it.
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => { setResetToken(null); setResetMsg(''); }, 2500);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleResendVerification = async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/resend-verification`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentUser?.user?.email })
      });
      const data = await res.json();
      alert(data.message || 'Verification email sent.');
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Currency helper — uses company currency, never hardcoded
  const companyCurrency = currentUser?.company?.currencySymbol || currentUser?.company?.currency || 'UGX';

  const publicSlug = getPublicSlugFromUrl();
  if (publicSlug) {
    const totalCartItemsCount = Object.values(publicCart).reduce((a, b) => a + b, 0);
    const cartTotalPricePerDay = Object.entries(publicCart).reduce((total, [itemId, qty]) => {
      const dbItem = publicItems.find(item => item.id === parseInt(itemId));
      return total + (dbItem ? Number(dbItem.dailyRentalRate) * qty : 0);
    }, 0);

    const publicDays = (publicPickupDate && publicReturnDate) 
      ? Math.max(1, Math.ceil((new Date(publicReturnDate).getTime() - new Date(publicPickupDate).getTime()) / (1000 * 60 * 60 * 24)))
      : 1;

    return (
      <div className={`min-h-screen bg-neo transition-colors duration-300 ${isDarkMode ? 'dark' : ''}`}>
        <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-8">
          
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-3xl">
            <div className="flex items-center space-x-3.5">
              <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white font-black text-lg flex items-center justify-center shadow-lg shadow-blue-500/25">
                {publicCompany?.name?.[0] || 'Y'}
              </div>
              <div>
                <h1 className="text-lg font-black text-slate-800 dark:text-slate-100">{publicCompany?.name || 'Loading Catalog...'}</h1>
                <p className="text-[10px] text-blue-600 dark:text-blue-400 font-bold uppercase tracking-wider font-mono">Public Reservation Portal</p>
              </div>
            </div>
            
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-3 rounded-2xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm active-shrink transition-all cursor-pointer text-slate-500 dark:text-slate-400"
            >
              {isDarkMode ? <Sun size={16} className="text-amber-500" /> : <Moon size={16} className="text-blue-500" />}
            </button>
          </div>

          {publicCatalogLoading ? (
            <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-12 rounded-3xl text-center">
              <div className="animate-spin inline-block w-8 h-8 border-4 border-current border-t-transparent text-blue-600 rounded-full" role="status"></div>
              <p className="mt-4 text-xs font-bold text-slate-500 uppercase">Fetching Catalog Inventory...</p>
            </div>
          ) : publicCatalogError ? (
            <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-12 rounded-3xl text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-red-500/10 text-red-500 flex items-center justify-center mx-auto">
                <AlertCircle size={24} />
              </div>
              <h2 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase">Catalog Unavailable</h2>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">{publicCatalogError}</p>
            </div>
          ) : publicBookingSuccess ? (
            <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-8 md:p-12 rounded-3xl text-center space-y-6 max-w-md mx-auto animate-fade-in">
              <div className="w-16 h-16 rounded-3xl bg-green-500/10 text-green-500 flex items-center justify-center mx-auto shadow-inner">
                <CheckCircle2 size={32} />
              </div>
              <div className="space-y-2">
                <h2 className="text-base font-black text-slate-800 dark:text-slate-200 uppercase">Reservation Confirmed!</h2>
                <p className="text-xs text-slate-500">Your rental booking request has been successfully created. Please save your booking details below.</p>
              </div>

              <div className="bg-neo shadow-neo-inset p-4 rounded-2xl space-y-3 font-mono text-left border border-slate-200/5">
                <div className="flex justify-between text-xs border-b border-slate-200/5 pb-2">
                  <span className="text-slate-400">Booking Reference</span>
                  <span className="font-bold text-blue-600 dark:text-blue-400">{publicBookingSuccess.bookingNumber}</span>
                </div>
                <div className="flex justify-between text-xs border-b border-slate-200/5 pb-2">
                  <span className="text-slate-400">Customer Name</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">{publicBookingSuccess.customerName}</span>
                </div>
                <div className="flex justify-between text-xs border-b border-slate-200/5 pb-2">
                  <span className="text-slate-400">Estimated Total</span>
                  <span className="font-bold text-green-600 dark:text-green-400">UGX {Number(publicBookingSuccess.estimatedTotalCost).toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Required Deposit</span>
                  <span className="font-bold text-amber-500">UGX {Number(publicBookingSuccess.depositAmount).toLocaleString()}</span>
                </div>
              </div>

              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-[10px] text-amber-700 dark:text-amber-400 font-bold text-left">
                ⚠️ {publicCompany?.name || 'Mega Rentals'} will review your booking and follow up with payment instructions. Your items are locked for 24 hours.
              </div>

              <button
                onClick={() => setPublicBookingSuccess(null)}
                className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-lg active-shrink transition-all cursor-pointer"
              >
                Book More Items
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              
              {/* Items Catalog List */}
              <div className="lg:col-span-2 space-y-6">
                <div className="flex items-center justify-between border-b border-slate-200/10 pb-4">
                  <h2 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase tracking-wider">Catalog Inventory</h2>
                  <span className="text-[10px] text-slate-400 font-bold font-mono uppercase">{publicItems.length} Products listed</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {publicItems.map(item => {
                    const quantityInCart = publicCart[item.id] || 0;
                    return (
                      <div key={item.id} className="bg-neo shadow-neo-outset border border-slate-200/5 p-4 rounded-3xl flex flex-col justify-between space-y-4">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black uppercase bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full">
                              {item.category}
                            </span>
                            <span className="text-[10px] text-slate-400 font-mono font-medium">Daily Rate</span>
                          </div>
                          <h3 className="text-xs font-black text-slate-800 dark:text-slate-200 leading-tight">{item.name}</h3>
                          <p className="text-[10px] text-slate-400 line-clamp-2">High-quality {item.name.toLowerCase()} clean and ready for hire.</p>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-slate-200/5">
                          <span className="text-xs font-black text-green-600 dark:text-green-400 font-mono">
                            UGX {Number(item.dailyRentalRate).toLocaleString()}
                          </span>
                          
                          <div className="flex items-center space-x-2">
                            {quantityInCart > 0 ? (
                              <div className="flex items-center space-x-2 bg-neo shadow-neo-inset p-1 rounded-xl">
                                <button
                                  onClick={() => setPublicCart({ ...publicCart, [item.id]: Math.max(0, quantityInCart - 1) })}
                                  className="w-6 h-6 rounded-lg bg-neo shadow-neo-outset flex items-center justify-center text-xs font-bold text-slate-600 dark:text-slate-400 hover:shadow-neo-inset-sm active-shrink transition-all cursor-pointer"
                                >
                                  -
                                </button>
                                <span className="text-xs font-bold font-mono px-1 min-w-[14px] text-center text-slate-800 dark:text-slate-200">{quantityInCart}</span>
                                <button
                                  onClick={() => setPublicCart({ ...publicCart, [item.id]: quantityInCart + 1 })}
                                  className="w-6 h-6 rounded-lg bg-neo shadow-neo-outset flex items-center justify-center text-xs font-bold text-slate-600 dark:text-slate-400 hover:shadow-neo-inset-sm active-shrink transition-all cursor-pointer"
                                >
                                  +
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setPublicCart({ ...publicCart, [item.id]: 1 })}
                                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] rounded-xl shadow-md active-shrink transition-all cursor-pointer uppercase tracking-wider"
                              >
                                Add to Cart
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Booking Request Drawer */}
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-3xl self-start space-y-6">
                <div className="border-b border-slate-200/10 pb-4">
                  <h3 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase tracking-wider">Checkout Cart</h3>
                  <span className="text-[10px] text-slate-400 font-bold font-mono">{totalCartItemsCount} Items selected</span>
                </div>

                {totalCartItemsCount === 0 ? (
                  <div className="text-center py-8 space-y-2">
                    <p className="text-xs font-bold text-slate-400 uppercase">Cart is Empty</p>
                    <p className="text-[10px] text-slate-500">Select products from the catalog to populate your hire reservation cart.</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Selected items list */}
                    <div className="space-y-3 max-h-48 overflow-y-auto pr-1">
                      {Object.entries(publicCart).map(([itemId, qty]) => {
                        if (qty === 0) return null;
                        const dbItem = publicItems.find(item => item.id === parseInt(itemId));
                        if (!dbItem) return null;
                        return (
                          <div key={itemId} className="flex items-center justify-between text-xs bg-neo shadow-neo-inset p-2.5 rounded-xl border border-slate-200/5">
                            <div className="truncate pr-2">
                              <p className="font-bold text-slate-700 dark:text-slate-300 truncate leading-tight">{dbItem.name}</p>
                              <span className="text-[9px] font-mono text-slate-400">Qty: {qty} × UGX {Number(dbItem.dailyRentalRate).toLocaleString()}</span>
                            </div>
                            <span className="font-mono font-bold text-slate-600 dark:text-slate-400 shrink-0">
                              UGX {(Number(dbItem.dailyRentalRate) * qty).toLocaleString()}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Booking Dates */}
                    <div className="grid grid-cols-2 gap-4 border-t border-slate-200/10 pt-4">
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500">Pickup Date</label>
                        <input 
                          type="date"
                          value={publicPickupDate}
                          onChange={e => setPublicPickupDate(e.target.value)}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-[11px] text-slate-700 dark:text-slate-300 focus:outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500">Return Date</label>
                        <input 
                          type="date"
                          value={publicReturnDate}
                          onChange={e => setPublicReturnDate(e.target.value)}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-[11px] text-slate-700 dark:text-slate-300 focus:outline-none"
                        />
                      </div>
                    </div>

                    {/* Customer Info Form */}
                    <div className="space-y-4 border-t border-slate-200/10 pt-4">
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500">Your Full Name</label>
                        <input 
                          type="text"
                          value={publicCustomerName}
                          onChange={e => setPublicCustomerName(e.target.value)}
                          placeholder="Sarah Kabasomi"
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-700 dark:text-slate-300 focus:outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500">Contact Details (Phone / Email)</label>
                        <input 
                          type="text"
                          value={publicContactInfo}
                          onChange={e => setPublicContactInfo(e.target.value)}
                          placeholder="sarah@gmail.com, +256772123456"
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-700 dark:text-slate-300 focus:outline-none"
                        />
                      </div>
                    </div>

                    {/* Totals Summary */}
                    <div className="bg-neo shadow-neo-inset p-3 rounded-2xl space-y-2 border border-slate-200/5">
                      <div className="flex justify-between text-[10px] text-slate-400 font-bold uppercase">
                        <span>Cart Subtotal (Per Day)</span>
                        <span className="font-mono text-slate-700 dark:text-slate-300">UGX {cartTotalPricePerDay.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-[10px] text-slate-400 font-bold uppercase">
                        <span>Estimated Hire Period</span>
                        <span className="font-mono text-slate-700 dark:text-slate-300">{publicDays} Days</span>
                      </div>
                      <div className="flex justify-between text-xs text-slate-700 dark:text-slate-300 font-black uppercase pt-1.5 border-t border-slate-200/5">
                        <span>Total Estimated cost</span>
                        <span className="font-mono text-green-600 dark:text-green-400">UGX {(cartTotalPricePerDay * publicDays).toLocaleString()}</span>
                      </div>
                    </div>

                    <button
                      onClick={handlePublicBookingSubmit}
                      disabled={submittingPublicBooking}
                      className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-lg active-shrink transition-all cursor-pointer flex items-center justify-center space-x-2"
                    >
                      {submittingPublicBooking ? (
                        <>
                          <div className="animate-spin inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent text-white rounded-full"></div>
                          <span>Submitting...</span>
                        </>
                      ) : (
                        <span>Submit Booking Reservation</span>
                      )}
                    </button>
                  </div>
                )}
              </div>

            </div>
          )}
        </div>
      </div>
    );
  }

  // Desktop license gate — blocks the app when the trial/grace window is exhausted.
  // Never triggers on web/dev (server reports blocked=false when enforcement is off).
  if (licenseStatus?.blocked) {
    return (
      <div className={`flex items-center justify-center h-screen bg-neo transition-colors duration-300 ${isDarkMode ? 'dark' : ''}`}>
        <div className="w-full max-w-lg mx-4 bg-neo shadow-neo-outset border border-slate-200/10 rounded-3xl p-8 space-y-5">
          <div className="flex items-center space-x-3">
            <div className="w-11 h-11 rounded-2xl bg-red-500/10 flex items-center justify-center"><ShieldAlert className="text-red-500" size={22} /></div>
            <div>
              <h1 className="text-lg font-black text-slate-800 dark:text-slate-100">License required</h1>
              <p className="text-[11px] text-slate-500">{licenseStatus.message}</p>
            </div>
          </div>

          <div className="bg-neo shadow-neo-inset-sm rounded-2xl p-4 space-y-1">
            <p className="text-[10px] uppercase font-black text-slate-500">This machine's fingerprint</p>
            <div className="flex items-center justify-between gap-2">
              <code className="text-[13px] font-mono font-bold text-slate-800 dark:text-slate-200 select-all break-all">{licenseStatus.fingerprint}</code>
              <button onClick={copyFingerprint} className="shrink-0 p-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-lg text-slate-500 hover:text-blue-500 active-shrink transition-all cursor-pointer" title="Copy"><Download size={13} /></button>
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed">Send this fingerprint to your vendor to receive a license key valid for this computer.</p>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] uppercase font-black text-slate-500">Enter your license key</label>
            <textarea
              value={licenseKeyInput}
              onChange={e => setLicenseKeyInput(e.target.value)}
              rows={3}
              placeholder="Paste the license key you received…"
              className="w-full bg-neo shadow-neo-inset-sm border-none rounded-xl p-3 text-[11px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none resize-none"
            />
            <button
              onClick={handleActivateLicense}
              disabled={activatingLicense}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-sm rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink transition-all cursor-pointer"
            >
              {activatingLicense ? 'Activating…' : 'Activate License'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    const pwStrength = getPasswordStrength(su_password);

    return (
      <div className={`flex h-screen bg-neo transition-colors duration-300 ${isDarkMode ? 'dark' : ''}`}>
        {/* Left branding panel */}
        <div className="hidden lg:flex flex-col justify-between w-2/5 bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-700 p-12 relative overflow-hidden">
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: "radial-gradient(circle at 20% 80%, white 1px, transparent 1px), radial-gradient(circle at 80% 20%, white 1px, transparent 1px)", backgroundSize: "60px 60px" }} />
          <div className="relative z-10">
            <div className="flex items-center space-x-3">
              <div className="w-12 h-12 rounded-2xl bg-white/20 backdrop-blur flex items-center justify-center font-black text-white text-xl">YH</div>
              <div>
                <h1 className="text-white font-black text-xl leading-none">YourHires</h1>
                <span className="text-blue-200 text-[10px] font-mono tracking-widest font-bold">RENTAL ENGINE</span>
              </div>
            </div>
          </div>
          <div className="relative z-10 space-y-8">
            <div>
              {!IS_DESKTOP && (
                <div className="inline-flex items-center space-x-2 bg-white/15 backdrop-blur rounded-xl px-4 py-2 mb-6">
                  <span className="text-green-300 text-sm">✦</span>
                  <span className="text-white text-xs font-bold tracking-wide">30-Day Free Trial — No credit card required</span>
                </div>
              )}
              <h2 className="text-3xl font-black text-white leading-tight">Enterprise rental management, built for your market.</h2>
              <p className="text-blue-200 text-sm mt-3 leading-relaxed">Manage bookings, assets, invoices, staff scheduling, and suppliers — all in one beautifully designed platform.</p>
            </div>
            <div className="space-y-3">
              {['Works with your local currency', ...(!IS_DESKTOP ? ['Automatic 30-day free trial on signup'] : []), 'Multi-tenant company isolation', 'Role-based access control'].map(f => (
                <div key={f} className="flex items-center space-x-3">
                  <div className="w-5 h-5 rounded-full bg-green-400/20 flex items-center justify-center shrink-0">
                    <span className="text-green-300 text-xs">✓</span>
                  </div>
                  <span className="text-blue-100 text-xs">{f}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="relative z-10 text-blue-300 text-[10px]">© 2025 YourHires. All rights reserved.</div>
        </div>

        {/* Right form panel */}
        <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-y-auto">
          <div className="w-full max-w-md space-y-6">
            {/* Tab toggle */}
            <div className="flex bg-neo shadow-neo-inset-sm rounded-2xl p-1">
              <button onClick={() => setShowSignup(false)} className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${!showSignup ? 'bg-neo shadow-neo-outset text-blue-600 dark:text-blue-400' : 'text-slate-400'}`}>Sign In</button>
              <button onClick={() => { setShowSignup(true); setSignupStep(1); setSignupError(''); }} className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${showSignup ? 'bg-neo shadow-neo-outset text-blue-600 dark:text-blue-400' : 'text-slate-400'}`}>Create Account</button>
            </div>

            {/* RESET PASSWORD PANEL (shown when arriving from the emailed link) */}
            {resetToken && (
              <div className="bg-neo shadow-neo-outset rounded-3xl p-8 space-y-6 border border-[#cbd5e1]/10 dark:border-slate-800/10 animate-fade-in">
                <div className="text-center space-y-1">
                  <h2 className="text-lg font-black text-slate-800 dark:text-white">Set a new password</h2>
                  <p className="text-[11px] text-slate-500">Enter a new password for your account.</p>
                </div>
                {resetMsg ? (
                  <div className="bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400 text-xs rounded-xl p-3 text-center font-semibold">{resetMsg}</div>
                ) : (
                  <>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">New Password</label>
                      <input type="password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} placeholder="At least 8 characters" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" onKeyDown={e => { if (e.key === 'Enter') handleResetPassword(); }} />
                    </div>
                    <button onClick={handleResetPassword} disabled={authBusy} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-3 rounded-xl shadow-lg active-shrink cursor-pointer transition-all disabled:opacity-60">{authBusy ? 'Saving…' : 'Reset Password'}</button>
                  </>
                )}
                <button onClick={() => { setResetToken(null); window.history.replaceState({}, '', window.location.pathname); }} className="w-full text-[11px] text-slate-500 hover:text-blue-600 cursor-pointer">← Back to sign in</button>
              </div>
            )}

            {/* FORGOT PASSWORD PANEL */}
            {!resetToken && showForgot && (
              <div className="bg-neo shadow-neo-outset rounded-3xl p-8 space-y-6 border border-[#cbd5e1]/10 dark:border-slate-800/10 animate-fade-in">
                <div className="text-center space-y-1">
                  <h2 className="text-lg font-black text-slate-800 dark:text-white">Reset your password</h2>
                  <p className="text-[11px] text-slate-500">We'll email you a link to set a new password.</p>
                </div>
                {forgotMsg ? (
                  <div className="bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 text-xs rounded-xl p-3 text-center font-semibold">{forgotMsg}</div>
                ) : (
                  <>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Account Email</label>
                      <input type="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} placeholder="you@company.com" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" onKeyDown={e => { if (e.key === 'Enter') handleForgotPassword(); }} />
                    </div>
                    <button onClick={handleForgotPassword} disabled={authBusy} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-3 rounded-xl shadow-lg active-shrink cursor-pointer transition-all disabled:opacity-60">{authBusy ? 'Sending…' : 'Send Reset Link'}</button>
                  </>
                )}
                <button onClick={() => { setShowForgot(false); setForgotMsg(''); }} className="w-full text-[11px] text-slate-500 hover:text-blue-600 cursor-pointer">← Back to sign in</button>
              </div>
            )}

            {/* LOGIN PANEL */}
            {!showSignup && !showForgot && !resetToken && (
              <div className="bg-neo shadow-neo-outset rounded-3xl p-8 space-y-6 border border-[#cbd5e1]/10 dark:border-slate-800/10 animate-fade-in">
                <div className="text-center space-y-1">
                  <h2 className="text-lg font-black text-slate-800 dark:text-white">Welcome back</h2>
                  <p className="text-[11px] text-slate-500">Sign in to your YourHires workspace</p>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Username</label>
                    <input type="text" value={loginUsername} onChange={e => setLoginUsername(e.target.value)} placeholder="E.g. admin" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Password</label>
                    <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} placeholder="••••••••" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }} />
                  </div>
                </div>
                <button onClick={handleLogin} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-3 rounded-xl shadow-lg active-shrink cursor-pointer transition-all">Sign In to Dashboard</button>
                <button onClick={() => { setShowForgot(true); setForgotEmail(loginUsername.includes('@') ? loginUsername : ''); setForgotMsg(''); }} className="w-full text-[11px] text-slate-500 hover:text-blue-600 cursor-pointer -mt-2">Forgot password?</button>
                <p className="text-center text-[11px] text-slate-500">No account? <button onClick={() => { setShowSignup(true); setSignupStep(1); }} className="text-blue-600 font-bold hover:underline cursor-pointer">{IS_DESKTOP ? 'Create an account →' : 'Start your 30-day free trial →'}</button></p>
              </div>
            )}

            {/* SIGNUP WIZARD PANEL */}
            {showSignup && (
              <div className="bg-neo shadow-neo-outset rounded-3xl p-8 space-y-6 border border-[#cbd5e1]/10 dark:border-slate-800/10 animate-fade-in">
                {/* Trial badge */}
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <h2 className="text-base font-black text-slate-800 dark:text-white">
                      {signupStep === 1 && 'Organization Info'}
                      {signupStep === 2 && 'Locale & Currency'}
                      {signupStep === 3 && 'Admin Account'}
                      {signupStep === 4 && 'Review & Launch'}
                    </h2>
                    <p className="text-[10px] text-slate-500">Step {signupStep} of 4</p>
                  </div>
                  <div className="inline-flex items-center space-x-1 bg-green-500/10 border border-green-500/20 rounded-xl px-3 py-1.5">
                    <span className="text-green-500 text-xs">✦</span>
                    <span className="text-green-600 dark:text-green-400 text-[10px] font-bold">30-Day Free Trial</span>
                  </div>
                </div>

                {/* Step progress */}
                <div className="flex items-center space-x-2">
                  {[1,2,3,4].map(s => (
                    <div key={s} className="flex items-center flex-1">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 transition-all ${s < signupStep ? 'bg-green-500 text-white' : s === signupStep ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30' : 'bg-neo shadow-neo-outset-sm text-slate-400'}`}>
                        {s < signupStep ? '✓' : s}
                      </div>
                      {s < 4 && <div className={`h-0.5 flex-1 mx-1 rounded transition-all ${s < signupStep ? 'bg-green-500' : 'bg-slate-200/20'}`} />}
                    </div>
                  ))}
                </div>

                {/* Step 1: Org Info */}
                {signupStep === 1 && (
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Business Name *</label>
                      <input type="text" value={su_companyName} onChange={e => setSu_companyName(e.target.value)} placeholder="E.g. Apex Equipment Rentals Ltd" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Industry / Business Type</label>
                      <select value={su_industry} onChange={e => setSu_industry(e.target.value)} className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer">
                        <option>Equipment Rental</option>
                        <option>Event Equipment Rental</option>
                        <option>Audio Visual Rental</option>
                        <option>Construction Equipment Rental</option>
                        <option>Furniture & Tent Rental</option>
                        <option>Vehicle Rental</option>
                        <option>Medical Equipment Rental</option>
                        <option>IT Equipment Rental</option>
                        <option>Other Rental Business</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Business Address</label>
                      <input type="text" value={su_address} onChange={e => setSu_address(e.target.value)} placeholder="Street address, city, country" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Business Phone</label>
                      <input type="tel" value={su_phone} onChange={e => setSu_phone(e.target.value)} placeholder="+256 700 000 000" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                    </div>
                  </div>
                )}

                {/* Step 2: Locale & Currency */}
                {signupStep === 2 && (
                  <div className="space-y-4">
                    <div className="bg-blue-500/5 border border-blue-500/15 rounded-2xl p-3 text-[11px] text-blue-600 dark:text-blue-400 font-medium">
                      💡 Select your country and we'll automatically configure your currency and timezone. You can customize them below.
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Base Country *</label>
                      <select value={su_country} onChange={e => handleCountryChange(e.target.value)} className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer">
                        {Object.entries(COUNTRY_MAP).map(([code, info]) => (
                          <option key={code} value={code}>{info.name} ({code})</option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500 block">Currency Code *</label>
                        <input type="text" value={su_currency} onChange={e => setSu_currency(e.target.value.toUpperCase())} placeholder="UGX" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500 block">Currency Symbol *</label>
                        <input type="text" value={su_currencySymbol} onChange={e => setSu_currencySymbol(e.target.value)} placeholder="UGX" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Timezone</label>
                      <input type="text" value={su_timezone} onChange={e => setSu_timezone(e.target.value)} placeholder="Africa/Kampala" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
                    </div>
                    <div className="bg-neo shadow-neo-inset-sm rounded-2xl p-3 space-y-1.5">
                      <p className="text-[10px] font-bold text-slate-500 uppercase">Preview</p>
                      <p className="text-xs text-slate-700 dark:text-slate-300 font-mono">Sample rental amount: <span className="font-black text-green-600">{su_currencySymbol} 250,000</span></p>
                      <p className="text-[11px] text-slate-500">All invoices, receipts, and rental orders will display amounts in <strong>{su_currency}</strong>.</p>
                    </div>
                  </div>
                )}

                {/* Step 3: Admin Account */}
                {signupStep === 3 && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500 block">First Name *</label>
                        <input type="text" value={su_firstName} onChange={e => setSu_firstName(e.target.value)} placeholder="John" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500 block">Last Name *</label>
                        <input type="text" value={su_lastName} onChange={e => setSu_lastName(e.target.value)} placeholder="Doe" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Email Address *</label>
                      <input type="email" value={su_email} onChange={e => setSu_email(e.target.value)} placeholder="admin@yourbusiness.com" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Username *</label>
                      <div className="relative">
                        <input type="text" value={su_username} onChange={e => setSu_username(e.target.value.toLowerCase().replace(/\s/g, '_'))} placeholder="john_doe" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 pr-10 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs">
                          {su_usernameStatus === 'checking' && <span className="text-slate-400 animate-pulse">…</span>}
                          {su_usernameStatus === 'available' && <span className="text-green-500">✓</span>}
                          {su_usernameStatus === 'taken' && <span className="text-red-500">✗</span>}
                        </div>
                      </div>
                      {su_usernameStatus === 'available' && <p className="text-[10px] text-green-500 font-bold">Username is available!</p>}
                      {su_usernameStatus === 'taken' && <p className="text-[10px] text-red-500 font-bold">Username is already taken.</p>}
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Password *</label>
                      <input type="password" value={su_password} onChange={e => setSu_password(e.target.value)} placeholder="Minimum 8 characters" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                      {su_password.length > 0 && (
                        <div className="space-y-1 pt-1">
                          <div className="flex space-x-1">
                            {[1,2,3,4,5].map(i => <div key={i} className={`h-1 flex-1 rounded-full transition-all ${i <= pwStrength.score ? pwStrength.color : 'bg-slate-200/20'}`} />)}
                          </div>
                          <p className={`text-[10px] font-bold ${pwStrength.score <= 1 ? 'text-red-500' : pwStrength.score <= 2 ? 'text-amber-500' : pwStrength.score <= 3 ? 'text-blue-500' : 'text-green-500'}`}>{pwStrength.label} password</p>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Confirm Password *</label>
                      <input type="password" value={su_confirmPassword} onChange={e => setSu_confirmPassword(e.target.value)} placeholder="Repeat password" className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                      {su_confirmPassword.length > 0 && su_password !== su_confirmPassword && <p className="text-[10px] text-red-500 font-bold">Passwords do not match.</p>}
                    </div>
                  </div>
                )}

                {/* Step 4: Review & Launch */}
                {signupStep === 4 && (
                  <div className="space-y-4">
                    <div className="bg-green-500/5 border border-green-500/15 rounded-2xl p-4 space-y-2">
                      <p className="text-[10px] font-black text-green-600 dark:text-green-400 uppercase tracking-wider">Your 30-Day Free Trial</p>
                      <p className="text-xs text-slate-600 dark:text-slate-400">Full access to all features for 30 days. No credit card required. Upgrade anytime.</p>
                    </div>
                    <div className="bg-neo shadow-neo-inset-sm rounded-2xl p-4 space-y-3 text-xs">
                      <div className="grid grid-cols-2 gap-y-2">
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Business</span>
                        <span className="text-slate-700 dark:text-slate-200 font-semibold truncate">{su_companyName || '—'}</span>
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Industry</span>
                        <span className="text-slate-700 dark:text-slate-200 truncate">{su_industry}</span>
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Country</span>
                        <span className="text-slate-700 dark:text-slate-200">{COUNTRY_MAP[su_country]?.name || su_country}</span>
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Currency</span>
                        <span className="text-slate-700 dark:text-slate-200 font-mono font-bold">{su_currencySymbol} ({su_currency})</span>
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Timezone</span>
                        <span className="text-slate-700 dark:text-slate-200 font-mono text-[10px]">{su_timezone}</span>
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Admin User</span>
                        <span className="text-slate-700 dark:text-slate-200">{su_firstName} {su_lastName}</span>
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Username</span>
                        <span className="text-slate-700 dark:text-slate-200 font-mono">{su_username}</span>
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Email</span>
                        <span className="text-slate-700 dark:text-slate-200 truncate">{su_email}</span>
                        <span className="text-slate-400 font-bold text-[10px] uppercase">Plan</span>
                        <span className="text-green-600 dark:text-green-400 font-bold">Free Trial (30 days)</span>
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-400 text-center">By creating an account you agree to our Terms of Service and Privacy Policy.</p>
                  </div>
                )}

                {/* Error display */}
                {signupError && (
                  <div className="flex items-center space-x-2 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                    <AlertTriangle size={14} className="text-red-500 shrink-0" />
                    <p className="text-[11px] text-red-500 font-bold">{signupError}</p>
                  </div>
                )}

                {/* Step navigation */}
                <div className="flex space-x-3">
                  {signupStep > 1 && (
                    <button onClick={() => { setSignupStep(s => s - 1); setSignupError(''); }} className="flex-1 py-2.5 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer transition-all">← Back</button>
                  )}
                  {signupStep < 4 && (
                    <button
                      onClick={() => {
                        if (signupStep === 1 && !su_companyName.trim()) { setSignupError('Business name is required to continue.'); return; }
                        if (signupStep === 2 && (!su_currency.trim() || !su_currencySymbol.trim())) { setSignupError('Currency code and symbol are required.'); return; }
                        setSignupError('');
                        setSignupStep(s => s + 1);
                      }}
                      className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md active-shrink cursor-pointer transition-all"
                    >
                      Continue →
                    </button>
                  )}
                  {signupStep === 4 && (
                    <button onClick={handleRegister} disabled={signupLoading} className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-white text-xs font-bold shadow-md active-shrink cursor-pointer transition-all disabled:opacity-60">
                      {signupLoading ? 'Creating Account…' : '🚀 Launch My Workspace'}
                    </button>
                  )}
                </div>

                <p className="text-center text-[11px] text-slate-500">Already have an account? <button onClick={() => setShowSignup(false)} className="text-blue-600 font-bold hover:underline cursor-pointer">Sign in →</button></p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── SUPER-ADMIN / PLATFORM CONSOLE ──
  // Shown instead of the tenant app when a platform superuser signs in.
  if (currentUser?.user?.isSuperuser) {
    const fmt = (n: number) => (n || 0).toLocaleString();
    return (
      <div className={`min-h-screen bg-neo transition-colors duration-300 ${isDarkMode ? 'dark' : ''}`}>
        <div className="max-w-6xl mx-auto p-6 space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-blue-600 flex items-center justify-center font-black text-white">YH</div>
              <div>
                <h1 className="text-lg font-black text-slate-800 dark:text-slate-100">Platform Console</h1>
                <p className="text-[11px] text-slate-500">Signed in as <strong>{currentUser.user.username}</strong> · super-admin</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-xl text-slate-500 active-shrink transition-all cursor-pointer">{isDarkMode ? <Sun size={16} /> : <Moon size={16} />}</button>
              <button onClick={fetchAdminData} className="px-3 py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-xl text-[11px] font-bold text-slate-600 dark:text-slate-300 active-shrink transition-all cursor-pointer flex items-center gap-1.5"><RotateCcw size={13} /> Refresh</button>
              <button onClick={handleLogout} className="px-3 py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-xl text-[11px] font-bold text-red-500 active-shrink transition-all cursor-pointer flex items-center gap-1.5"><LogOut size={13} /> Sign out</button>
            </div>
          </div>

          {/* Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Companies', value: adminMetrics?.totalCompanies, sub: `${adminMetrics?.activeCompanies ?? 0} active · ${adminMetrics?.suspendedCompanies ?? 0} suspended` },
              { label: 'Total Users', value: adminMetrics?.totalUsers },
              { label: 'Total Customers', value: adminMetrics?.totalCustomers },
              { label: 'Platform Revenue', value: adminMetrics?.totalRevenue, money: true },
            ].map((m) => (
              <div key={m.label} className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl p-4">
                <p className="text-[10px] uppercase font-black text-slate-500">{m.label}</p>
                <p className="text-2xl font-black text-slate-800 dark:text-slate-100 mt-1">{m.money ? '' : ''}{adminMetrics ? fmt(m.value) : '—'}</p>
                {m.sub && <p className="text-[10px] text-slate-500 mt-0.5">{m.sub}</p>}
              </div>
            ))}
          </div>

          {/* Companies */}
          <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl p-5">
            <h2 className="text-xs font-black uppercase text-slate-700 dark:text-slate-300 border-b border-slate-200/10 pb-2 mb-3">Tenants</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                    <th className="p-2.5">Company</th>
                    <th className="p-2.5">Plan</th>
                    <th className="p-2.5 text-center">Users</th>
                    <th className="p-2.5 text-center">Orders</th>
                    <th className="p-2.5 text-center">Billing</th>
                    <th className="p-2.5 text-center">Status</th>
                    <th className="p-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/10">
                  {adminCompanies.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-200/5">
                      <td className="p-2.5">
                        <div className="font-bold text-slate-800 dark:text-slate-200">{c.name}</div>
                        <div className="text-[10px] text-slate-500">{c.email || 'no email'} · since {new Date(c.createdAt).toLocaleDateString()}</div>
                      </td>
                      <td className="p-2.5 text-slate-600 dark:text-slate-400">{c.plan?.name || '—'}</td>
                      <td className="p-2.5 text-center text-slate-600 dark:text-slate-400">{c.counts?.users ?? 0}{c.plan?.maxUsers ? ` / ${c.plan.maxUsers}` : ''}</td>
                      <td className="p-2.5 text-center text-slate-600 dark:text-slate-400">{c.counts?.rentalOrders ?? 0}</td>
                      <td className="p-2.5 text-center">
                        <select
                          value={c.paymentApprovalStatus}
                          onChange={(e) => handleAdminUpdateCompany(c.id, { paymentApprovalStatus: e.target.value })}
                          className="bg-neo shadow-neo-inset-sm border-none px-2 py-1 rounded-lg text-[10px] font-bold text-slate-700 dark:text-slate-300 cursor-pointer focus:outline-none"
                        >
                          <option value="approved">approved</option>
                          <option value="pending">pending</option>
                          <option value="rejected">rejected</option>
                        </select>
                      </td>
                      <td className="p-2.5 text-center">
                        <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${c.isActive ? 'text-green-600 bg-green-500/10 border border-green-500/20' : 'text-red-500 bg-red-500/10 border border-red-500/20'}`}>
                          {c.isActive ? 'Active' : 'Suspended'}
                        </span>
                      </td>
                      <td className="p-2.5 text-right">
                        <button
                          disabled={adminBusy}
                          onClick={() => handleAdminUpdateCompany(c.id, { isActive: !c.isActive },
                            c.isActive ? `Suspend "${c.name}"? Its users will be unable to sign in until reactivated.` : undefined)}
                          className={`px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-40 ${c.isActive ? 'text-red-500' : 'text-green-600'}`}
                        >
                          {c.isActive ? 'Suspend' : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {adminCompanies.length === 0 && (
                    <tr><td colSpan={7} className="p-4 text-center text-slate-400">No companies loaded.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Desktop license key generator */}
          <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-200/10 pb-2">
              <ShieldAlert size={15} className="text-blue-600 dark:text-blue-400" />
              <h2 className="text-xs font-black uppercase text-slate-700 dark:text-slate-300">Issue Desktop License Key</h2>
            </div>
            {adminMetrics && adminMetrics.canSignLicenses === false ? (
              <p className="text-[11px] text-amber-600">Signing key not present on this server — license generation is unavailable here. Run this on the vendor deployment that holds <code>license-signing-key.pem</code>.</p>
            ) : (
              <>
                <p className="text-[11px] text-slate-500">The customer reads their machine fingerprint from their app (License screen). Paste it here to issue a key bound to that machine.</p>
                <div className="grid sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-1">
                    <label className="text-[10px] uppercase font-black text-slate-500">Machine Fingerprint</label>
                    <input value={adminGenFp} onChange={(e) => setAdminGenFp(e.target.value)} placeholder="XXXX-XXXX-…" className="w-full bg-neo shadow-neo-inset-sm border-none rounded-lg p-2 text-[11px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none mt-1" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500">Valid (days, 0 = perpetual)</label>
                    <input type="number" value={adminGenDays} onChange={(e) => setAdminGenDays(e.target.value)} className="w-full bg-neo shadow-neo-inset-sm border-none rounded-lg p-2 text-[11px] font-bold text-slate-800 dark:text-slate-200 focus:outline-none mt-1" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500">Licensee (name)</label>
                    <input value={adminGenLicensee} onChange={(e) => setAdminGenLicensee(e.target.value)} placeholder="Acme Rentals Ltd" className="w-full bg-neo shadow-neo-inset-sm border-none rounded-lg p-2 text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none mt-1" />
                  </div>
                </div>
                <button onClick={handleAdminGenerateKey} disabled={adminBusy} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-lg active-shrink transition-all cursor-pointer">
                  {adminBusy ? 'Generating…' : 'Generate Key'}
                </button>
                {adminGenKey && (
                  <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-2">
                    <p className="text-[10px] uppercase font-black text-slate-500">License key — send this to the customer</p>
                    <code className="block text-[11px] font-mono text-slate-800 dark:text-slate-200 break-all select-all">{adminGenKey}</code>
                    <button onClick={() => { navigator.clipboard?.writeText(adminGenKey); alert('Key copied.'); }} className="px-3 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all cursor-pointer">Copy Key</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }



  return (
    <div className={`flex h-screen overflow-hidden bg-neo select-none transition-colors duration-300 ${isDarkMode ? 'dark' : ''}`}>

      {/* Welcome Toast */}
      {welcomeToast && (
        <div className="fixed top-5 right-5 z-[100] flex items-center space-x-3 bg-green-600 text-white text-xs font-bold px-5 py-3.5 rounded-2xl shadow-2xl shadow-green-500/30 animate-fade-in no-print">
          <span>{welcomeToast}</span>
          <button onClick={() => setWelcomeToast('')} className="text-white/70 hover:text-white cursor-pointer text-base leading-none">×</button>
        </div>
      )}

      {/* Desktop License Trial / Grace Banner */}
      {(licenseStatus?.state === 'trial' || licenseStatus?.state === 'grace') && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-white text-xs font-bold py-2 px-4 flex items-center justify-center space-x-3 no-print">
          <ShieldAlert size={13} />
          <span>
            {licenseStatus.state === 'grace'
              ? <>Your license has expired — <strong>{licenseStatus.daysLeft} day{licenseStatus.daysLeft !== 1 ? 's' : ''}</strong> of grace remaining. Please renew.</>
              : <>Trial mode — <strong>{licenseStatus.daysLeft} day{licenseStatus.daysLeft !== 1 ? 's' : ''}</strong> left. Activate a license key to keep using YourHires.</>}
          </span>
          <button className="ml-2 underline cursor-pointer font-black" onClick={() => setActiveTab('settings')}>Activate →</button>
        </div>
      )}

      {/* Trial Expiry Warning Banner */}
      {currentUser?.company?.trialActive && currentUser?.company?.trialDaysLeft !== undefined && currentUser.company.trialDaysLeft <= 7 && currentUser.company.trialDaysLeft > 0 && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-white text-xs font-bold py-2 px-4 flex items-center justify-center space-x-3 no-print">
          <AlertTriangle size={13} />
          <span>Your free trial expires in <strong>{currentUser.company.trialDaysLeft} day{currentUser.company.trialDaysLeft !== 1 ? 's' : ''}</strong>. Upgrade your plan to continue uninterrupted access.</span>
          <button className="ml-2 underline cursor-pointer font-black" onClick={() => setActiveTab('settings')}>Upgrade Now →</button>
        </div>
      )}

      {/* Trial Expired Blocking Overlay */}
      {currentUser?.company?.trialActive === false && currentUser?.company?.trialDaysLeft === 0 && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm no-print">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-10 max-w-md text-center space-y-5">
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto">
              <AlertCircle size={32} className="text-red-500" />
            </div>
            <h2 className="text-lg font-black text-slate-800 dark:text-white">Your Free Trial Has Expired</h2>
            <p className="text-sm text-slate-500">Your 30-day free trial has ended. Upgrade to a paid plan to continue using YourHires without interruption.</p>
            <button onClick={() => setActiveTab('settings')} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm py-3 rounded-xl shadow-lg active-shrink cursor-pointer transition-all">
              View Plans & Upgrade
            </button>
          </div>
        </div>
      )}

      {/* 1. SIDEBAR NAVIGATION */}

      <aside className="w-64 flex flex-col justify-between bg-neo shadow-neo-outset border-r border-[#cbd5e1]/10 dark:border-slate-800/10 p-5 z-10 h-screen shrink-0">
        <div className="space-y-6 shrink-0">
          {/* Brand Header */}
          <div className="flex items-center space-x-3 px-2">
            <div className="w-10 h-10 rounded-2xl bg-neo shadow-neo-outset flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold text-lg border border-[#cbd5e1]/20 dark:border-slate-800/20">
              YH
            </div>
            <div>
              <h1 className="font-extrabold text-slate-800 dark:text-slate-100 text-lg leading-none">YourHires</h1>
              <span className="text-[10px] text-blue-600 dark:text-blue-400 font-mono tracking-wider font-bold">RENTAL ENGINE</span>
            </div>
          </div>

          {/* Business Tenant Selector */}
          <div 
            onClick={() => setSelectedCompanyId(selectedCompanyId === 1 ? 2 : 1)}
            className="bg-neo shadow-neo-inset-sm rounded-xl px-3 py-2 flex items-center justify-between border border-transparent cursor-pointer active-shrink transition-all"
          >
            <div className="flex items-center space-x-2.5 truncate">
              <Building size={14} className="text-slate-500 shrink-0" />
              <div className="truncate">
                <p className="text-[10px] text-slate-400 font-bold uppercase leading-none">Current Business</p>
                <span className="text-[11px] text-slate-700 dark:text-slate-300 font-bold truncate block">{activeCompany.name}</span>
              </div>
            </div>
            <ChevronDown size={14} className="text-slate-400 shrink-0" />
          </div>
        </div>

        {/* Navigation Items */}
        <div className="flex-1 overflow-y-auto my-4 pr-1 min-h-0">
          <nav className="space-y-2">
            {[
              { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: ['dashboard', 'view'] },
              { id: 'bookings', label: 'Bookings', icon: CalendarRange, perm: ['bookings', 'view'] },
              { id: 'dispatches', label: 'Dispatches & Returns', icon: Truck, perm: ['dispatches', 'view'] },
              { id: 'customers', label: 'Customers', icon: Users, perm: ['customers', 'view'] },
              { id: 'ledgers', label: 'Customer Ledgers', icon: FileText, perm: ['ledgers', 'view'] },
              { id: 'inventory', label: 'Items & Assets', icon: Building, perm: ['inventory', 'view'] },
              { id: 'scheduling', label: 'Staff & Scheduling', icon: UserCheck, perm: ['staff', 'view'] },
              { id: 'revenue', label: 'Revenue Ledger', icon: TrendingUp, perm: ['revenue', 'view'] },
              { id: 'bookkeeping', label: 'Purchases & Payroll', icon: DollarSign, perm: ['purchases', 'view'] },
              { id: 'invoices', label: 'Invoices', icon: FileText, perm: ['invoices', 'view'] },
              { id: 'creditNotes', label: 'Credit Notes', icon: DollarSign, perm: ['creditNotes', 'view'] },
              { id: 'settings', label: 'Settings', icon: SettingsIcon, perm: ['settings', 'manage'] },
              { id: 'help', label: 'Help & Support', icon: HelpCircle },
              { id: 'health', label: 'System Health', icon: Activity, perm: ['settings', 'manage'] }
            ].filter(item => !item.perm || can(item.perm[0], item.perm[1]) || (item.id === 'settings' && can('team', 'manage'))).map(item => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id as any)}
                  className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl transition-all duration-200 active-shrink text-left ${
                    isActive 
                      ? 'bg-neo shadow-neo-inset text-blue-600 dark:text-blue-400 font-bold' 
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  <Icon size={16} className={isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500'} />
                  <span className="text-xs font-semibold">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Footer controls: Theme Toggler */}
        <div className="space-y-4 pt-4 border-t border-slate-200/10 shrink-0">
          <div className="flex items-center justify-between bg-neo shadow-neo-inset-sm p-1.5 rounded-2xl">
            <button
              onClick={() => setIsDarkMode(false)}
              className={`flex-1 py-1.5 rounded-xl flex items-center justify-center space-x-1.5 text-xs transition-all duration-200 ${
                !isDarkMode ? 'bg-neo shadow-neo-outset text-amber-500 font-bold' : 'text-slate-400'
              }`}
            >
              <Sun size={14} />
              <span>Light</span>
            </button>
            <button
              onClick={() => setIsDarkMode(true)}
              className={`flex-1 py-1.5 rounded-xl flex items-center justify-center space-x-1.5 text-xs transition-all duration-200 ${
                isDarkMode ? 'bg-neo shadow-neo-outset text-blue-400 font-bold' : 'text-slate-400'
              }`}
            >
              <Moon size={14} />
              <span>Dark</span>
            </button>
          </div>

          {/* User Profile Card & Logout */}
          <div className="bg-neo shadow-neo-inset-sm rounded-2xl p-3 flex items-center justify-between border border-transparent">
            <div className="flex items-center space-x-2.5 truncate">
              <div className="w-8 h-8 rounded-xl bg-blue-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                {currentUser?.user?.firstName?.[0] || 'A'}
              </div>
              <div className="truncate">
                <div className="flex items-center space-x-1">
                  <span className={`text-[8px] font-black uppercase px-1 rounded ${currentUser?.user?.role === 'Admin' ? 'bg-blue-500/10 text-blue-600' : 'bg-slate-400/15 text-slate-500'}`}>
                    {currentUser?.user?.roleName || (currentUser?.user?.role === 'Admin' ? 'Admin' : 'Staff')}
                  </span>
                </div>
                <span className="text-[11px] text-slate-700 dark:text-slate-300 font-bold block truncate mt-0.5">
                  {currentUser?.user?.firstName} {currentUser?.user?.lastName}
                </span>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-lg bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-red-500 active-shrink transition-all cursor-pointer"
              title="Logout Profile"
            >
              <LogOut size={13} />
            </button>
          </div>

          <div className="text-center">
            <span className="text-[10px] text-slate-400 font-bold font-mono">YH-DESKTOP v0.1.0</span>
          </div>
        </div>
      </aside>

      {/* MAIN CONTAINER */}
      <main className="flex-1 flex flex-col overflow-hidden p-6 space-y-6">

        {/* EMAIL VERIFICATION BANNER */}
        {currentUser?.user && currentUser.user.emailVerified === false && (
          <div className="shrink-0 flex items-center justify-between bg-amber-500/10 border border-amber-500/25 rounded-xl px-4 py-2.5">
            <p className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">
              ⚠ Your email <strong>{currentUser.user.email}</strong> isn't verified yet. Check your inbox for the confirmation link.
            </p>
            <button onClick={handleResendVerification} className="text-[11px] font-bold text-amber-700 dark:text-amber-400 hover:underline cursor-pointer whitespace-nowrap ml-3">Resend email</button>
          </div>
        )}

        {/* TOP BAR */}
        <header className="flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-black text-slate-800 dark:text-white capitalize">
              {activeTab === 'creditNotes' ? 'Credit Notes' : activeTab === 'customers' ? 'Customers' : activeTab === 'ledgers' ? 'Customer Ledger Accounts' : activeTab === 'bookkeeping' ? 'Purchases & Payroll' : activeTab === 'revenue' ? 'Revenue Ledger' : activeTab === 'help' ? 'Help & Support Center' : activeTab === 'health' ? 'System Diagnostic & Health Board' : activeTab === 'scheduling' ? 'Staff & Scheduling' : activeTab === 'dispatches' ? 'Dispatches & Returns' : activeTab}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Scoped to {activeCompany.name}</p>
          </div>
          
          <div className="flex items-center space-x-4">
            {/* Global search */}
            <div className="relative">
              <div className="flex items-center bg-neo shadow-neo-inset-sm rounded-xl px-3 py-2 w-56">
                <Search size={14} className="text-slate-400 shrink-0" />
                <input
                  value={globalQuery}
                  onChange={e => { setGlobalQuery(e.target.value); setShowSearchPanel(true); }}
                  onFocus={() => setShowSearchPanel(true)}
                  placeholder="Search everything…"
                  className="bg-transparent border-none outline-none text-xs text-slate-700 dark:text-slate-200 ml-2 w-full placeholder:text-slate-400"
                />
                {globalQuery && (
                  <button onClick={() => { setGlobalQuery(''); setSearchGroups([]); }} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X size={12} /></button>
                )}
              </div>

              {showSearchPanel && (globalQuery.trim().length >= 2 || savedSearches.length > 0) && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSearchPanel(false)} />
                  <div className="absolute left-0 mt-2 w-96 max-h-[70vh] overflow-hidden z-50 bg-neo shadow-neo-outset border border-slate-200/10 rounded-2xl flex flex-col animate-fade-in">
                    {/* Saved searches */}
                    {savedSearches.length > 0 && globalQuery.trim().length < 2 && (
                      <div className="p-3 space-y-1.5">
                        <p className="text-[10px] uppercase font-black text-slate-500">Saved Searches</p>
                        {savedSearches.map(s => (
                          <div key={s.id} className="flex items-center justify-between group">
                            <button onClick={() => setGlobalQuery(s.query)} className="text-[11px] text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer text-left">
                              {s.name} <span className="text-slate-400 font-mono">"{s.query}"</span>
                            </button>
                            <button onClick={() => deleteSavedSearch(s.id)} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 cursor-pointer"><Trash2 size={12} /></button>
                          </div>
                        ))}
                      </div>
                    )}

                    {globalQuery.trim().length >= 2 && (
                      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200/10">
                        <span className="text-[10px] text-slate-500">{searching ? 'Searching…' : `${searchTotal} result(s)`}</span>
                        <button onClick={saveCurrentSearch} className="text-[10px] font-bold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">Save this search</button>
                      </div>
                    )}

                    <div className="overflow-y-auto">
                      {globalQuery.trim().length >= 2 && searchGroups.length === 0 && !searching && (
                        <div className="p-6 text-center text-[11px] text-slate-400">No matches for "{globalQuery}".</div>
                      )}
                      {searchGroups.map(g => (
                        <div key={g.type} className="p-2">
                          <p className="text-[9px] uppercase font-black text-slate-400 px-1.5 mb-1">{g.label}</p>
                          {g.items.map(it => (
                            <button
                              key={g.type + it.id}
                              onClick={() => openSearchResult(g.tab)}
                              className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-slate-200/10 dark:hover:bg-slate-800/20 cursor-pointer text-left"
                            >
                              <span className="text-[11px] font-bold text-slate-800 dark:text-slate-200 truncate">{it.label}</span>
                              <span className="text-[10px] text-slate-500 truncate ml-2 shrink-0 max-w-[45%]">{it.sublabel}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Watchlist warning widget - dynamic */}
            {customers.filter(c => c.isOnWatchList).length > 0 && (
              <div
                className="flex items-center space-x-2 bg-neo shadow-neo-outset-sm border border-red-500/10 px-3 py-1.5 rounded-xl cursor-pointer active-shrink"
                onClick={() => setActiveTab('customers')}
              >
                <AlertTriangle size={14} className="text-amber-500" />
                <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400">
                  {customers.filter(c => c.isOnWatchList).length} Watchlisted
                </span>
              </div>
            )}

            {/* Notification bell */}
            <div className="relative">
              <button
                onClick={() => { setShowNotifPanel(v => !v); if (!showNotifPanel) fetchNotifications(); }}
                className="relative bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm p-2.5 rounded-xl active-shrink transition-all cursor-pointer"
                title="Notifications"
              >
                <Bell size={16} className="text-slate-600 dark:text-slate-300" />
                {visibleUnread > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center bg-red-600 text-white text-[9px] font-black rounded-full">
                    {visibleUnread > 9 ? '9+' : visibleUnread}
                  </span>
                )}
              </button>

              {showNotifPanel && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowNotifPanel(false)} />
                  <div className="absolute right-0 mt-2 w-80 max-h-[70vh] overflow-hidden z-50 bg-neo shadow-neo-outset border border-slate-200/10 rounded-2xl flex flex-col animate-fade-in">
                    <div className="flex items-center justify-between p-3 border-b border-slate-200/10">
                      <h4 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase">Notifications</h4>
                      {visibleUnread > 0 && (
                        <button onClick={markAllNotifsRead} className="text-[10px] font-bold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">Mark all read</button>
                      )}
                    </div>
                    <div className="overflow-y-auto divide-y divide-slate-200/10">
                      {visibleNotifications.length === 0 ? (
                        <div className="p-6 text-center text-[11px] text-slate-400">You're all caught up.</div>
                      ) : visibleNotifications.slice(0, 40).map(n => {
                        const meta = CAT_META[n.category] || CAT_META.system;
                        const Icon = meta.icon;
                        return (
                          <div
                            key={n.id}
                            onClick={() => !n.isRead && markNotifRead(n.id)}
                            className={`flex items-start space-x-2.5 p-3 cursor-pointer hover:bg-slate-200/5 dark:hover:bg-slate-800/10 ${!n.isRead ? 'bg-blue-500/[0.04]' : ''}`}
                          >
                            <Icon size={15} className={`${meta.color} mt-0.5 shrink-0`} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between">
                                <p className={`text-[11px] truncate ${!n.isRead ? 'font-black text-slate-800 dark:text-slate-100' : 'font-bold text-slate-600 dark:text-slate-400'}`}>{n.title}</p>
                                {!n.isRead && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0 ml-1" />}
                              </div>
                              <p className="text-[10px] text-slate-500 leading-snug mt-0.5">{n.message}</p>
                              <p className="text-[9px] text-slate-400 mt-1">{new Date(n.createdAt).toLocaleString()}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Quick action: Create Booking */}
            <button
              onClick={() => setShowBookingModal(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all"
            >
              <Plus size={14} />
              <span>New Booking</span>
            </button>
          </div>
        </header>

        {/* WORKSPACE CONTENT AREA */}
        <div className="flex-1 overflow-y-auto pr-1">
          
          {/* TAB 1: DASHBOARD */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">

              {/* SETUP CHECKLIST — shown until the company has dismissed it or finished every step */}
              {onboarding && !onboarding.dismissed && (
                <div className="bg-neo shadow-neo-outset border border-blue-500/10 p-5 rounded-2xl space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase">Getting Started</h3>
                      <p className="text-[10px] text-slate-500 mt-0.5">Finish these steps to set your workspace up for success.</p>
                    </div>
                    <button onClick={dismissOnboarding} className="text-[10px] font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer">Dismiss</button>
                  </div>
                  <div className="w-full bg-slate-200/20 dark:bg-slate-800/20 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-blue-500 h-full rounded-full transition-all duration-500" style={{ width: `${onboarding.percent}%` }} />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                    {onboarding.steps.map(s => (
                      <button
                        key={s.id}
                        onClick={() => setActiveTab(s.tab as typeof activeTab)}
                        className={`flex items-center space-x-2 p-2.5 rounded-xl text-left cursor-pointer active-shrink transition-all ${s.done ? 'bg-green-500/10 border border-green-500/20' : 'bg-neo shadow-neo-inset-sm border border-transparent hover:shadow-neo-outset-sm'}`}
                      >
                        {s.done ? <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-400 shrink-0" />}
                        <span className={`text-[10px] ${s.done ? 'text-green-700 dark:text-green-400 font-bold' : 'text-slate-600 dark:text-slate-400'}`}>{s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Dynamic Neomorphic Dashboard Filters */}
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-4 rounded-2xl">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center space-x-2">
                    <span className="text-[10px] uppercase font-bold text-slate-500">Filter By:</span>
                  </div>
                  
                  {/* Start Date */}
                  <div className="flex flex-col space-y-1">
                    <label className="text-[9px] uppercase font-bold text-slate-400">Start Date</label>
                    <input 
                      type="date"
                      value={analyticsStartDate}
                      onChange={e => setAnalyticsStartDate(e.target.value)}
                      className="bg-neo shadow-neo-inset-sm border-none px-3 py-1.5 rounded-xl text-xs text-slate-700 dark:text-slate-300 focus:outline-none"
                    />
                  </div>

                  {/* End Date */}
                  <div className="flex flex-col space-y-1">
                    <label className="text-[9px] uppercase font-bold text-slate-400">End Date</label>
                    <input 
                      type="date"
                      value={analyticsEndDate}
                      onChange={e => setAnalyticsEndDate(e.target.value)}
                      className="bg-neo shadow-neo-inset-sm border-none px-3 py-1.5 rounded-xl text-xs text-slate-700 dark:text-slate-300 focus:outline-none"
                    />
                  </div>

                  {/* Category */}
                  <div className="flex flex-col space-y-1">
                    <label className="text-[9px] uppercase font-bold text-slate-400">Category</label>
                    <select
                      value={analyticsCategory}
                      onChange={e => setAnalyticsCategory(e.target.value)}
                      className="bg-neo shadow-neo-inset-sm border-none px-3 py-1.5 rounded-xl text-xs text-slate-700 dark:text-slate-300 focus:outline-none"
                    >
                      <option value="All">All Categories</option>
                      <option value="Chairs">Chairs</option>
                      <option value="Tents">Tents</option>
                      <option value="Sound">Sound</option>
                      <option value="Power">Power</option>
                      <option value="Tables">Tables</option>
                    </select>
                  </div>

                  {/* Customer Search */}
                  <div className="flex flex-col space-y-1 flex-1 min-w-[150px]">
                    <label className="text-[9px] uppercase font-bold text-slate-400">Customer Name</label>
                    <input 
                      type="text"
                      placeholder="Search customer name..."
                      value={analyticsCustomer}
                      onChange={e => setAnalyticsCustomer(e.target.value)}
                      className="bg-neo shadow-neo-inset-sm border-none px-3 py-1.5 rounded-xl text-xs text-slate-700 dark:text-slate-300 focus:outline-none"
                    />
                  </div>

                  {/* Reset Filters */}
                  <div className="flex items-end self-end">
                    <button
                      onClick={() => {
                        setAnalyticsStartDate('');
                        setAnalyticsEndDate('');
                        setAnalyticsCategory('All');
                        setAnalyticsCustomer('');
                      }}
                      className="px-3 py-1.5 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink transition-all"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>

              {/* Financial & Activity Summary Metrics */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {[
                  { label: "Active Rental Income", value: can('revenue', 'view') ? `${companyCurrency} ${Number(dashboardStats.activeRentalIncome).toLocaleString()}` : "Restricted", trend: "Based on active orders", icon: DollarSign, color: "text-green-600 dark:text-green-400" },
                  { label: "Deposits Collected", value: can('revenue', 'view') ? `${companyCurrency} ${Number(dashboardStats.depositsCollected).toLocaleString()}` : "Restricted", trend: "Cleared bookings", icon: UserCheck, color: "text-blue-500 dark:text-blue-400" },
                  { label: "Outstanding Invoices", value: can('invoices', 'view') ? `${companyCurrency} ${Number(dashboardStats.outstandingInvoices).toLocaleString()}` : "Restricted", trend: "Overdue & unpaid invoices", icon: FileText, color: "text-red-500 dark:text-red-400" },
                  { label: "Asset Utilization", value: `${dashboardStats.assetUtilization}%`, trend: "Serialized assets leased", icon: TrendingUp, color: "text-indigo-500 dark:text-indigo-400" }
                ].map((card, i) => {
                  const CardIcon = card.icon;
                  return (
                    <div key={i} className="bg-neo shadow-neo-outset border border-slate-200/5 p-4 rounded-2xl flex items-center justify-between">
                      <div className="space-y-2">
                        <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase leading-none">{card.label}</p>
                        <h3 className={`text-lg font-black tracking-tight font-mono ${card.color}`}>{card.value}</h3>
                        <span className="text-[10px] font-medium text-slate-400 block">{card.trend}</span>
                      </div>
                      <div className="w-10 h-10 rounded-xl bg-neo shadow-neo-outset-sm flex items-center justify-center text-slate-400">
                        <CardIcon size={18} className={card.color} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Graphic Utilization chart & Alerts Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                
                {/* Custom Styled HTML/CSS Bar Chart */}
                <div className="md:col-span-2 bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Leased Inventory Utilization</h3>
                    <span className="text-[10px] text-blue-600 dark:text-blue-400 font-bold font-mono">Dynamic Live Rates</span>
                  </div>
                  
                  {/* Bars representation */}
                  <div className="space-y-3.5 pt-2">
                    {dashboardStats.utilizationChart && dashboardStats.utilizationChart.length > 0 ? (
                      dashboardStats.utilizationChart.map((bar, i) => {
                        let barColor = "bg-green-500 dark:bg-green-400";
                        if (bar.percent > 75) barColor = "bg-green-500 dark:bg-green-400";
                        else if (bar.percent > 45) barColor = "bg-blue-500 dark:bg-blue-400";
                        else if (bar.percent > 15) barColor = "bg-amber-500 dark:bg-amber-400";
                        else barColor = "bg-indigo-500 dark:bg-indigo-400";

                        return (
                          <div key={i} className="space-y-1">
                            <div className="flex justify-between items-center text-[11px]">
                              <span className="font-bold text-slate-700 dark:text-slate-300">{bar.name}</span>
                              <span className="text-slate-500 font-mono font-semibold">{bar.rented} / {bar.stock} rented ({bar.percent}%)</span>
                            </div>
                            <div className="w-full h-2.5 rounded-full bg-neo shadow-neo-inset-sm overflow-hidden p-0.5">
                              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${bar.percent}%` }}></div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-center py-6 text-slate-400 text-xs">
                        No inventory matching category filter or active rentals.
                      </div>
                    )}
                  </div>
                </div>

                {/* Operations checklist & Reminders panel */}
                <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl space-y-4 flex flex-col justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase mb-3">System Action Required</h3>
                    <div className="space-y-3">
                      {(() => {
                        const watchlisted = customers.filter(c => c.isOnWatchList);
                        const topOverdue = overdueAlerts.orders[0];
                        const hasAlerts = watchlisted.length > 0 || overdueAlerts.overdueCount > 0;

                        if (!hasAlerts) {
                          return (
                            <div className="flex items-start space-x-2.5 p-2 rounded-xl bg-green-500/5 border border-green-500/10">
                              <Check size={14} className="text-green-500 shrink-0 mt-0.5" />
                              <div>
                                <p className="text-[11px] font-bold text-slate-800 dark:text-slate-200">All Clear</p>
                                <span className="text-[10px] text-slate-500 block">No watchlisted customers or overdue returns.</span>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <>
                            {watchlisted.length > 0 && (
                              <div className="flex items-start space-x-2.5 p-2 rounded-xl bg-amber-500/5 border border-amber-500/10">
                                <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                                <div>
                                  <p className="text-[11px] font-bold text-slate-800 dark:text-slate-200">Watchlisted Customer{watchlisted.length !== 1 ? 's' : ''}</p>
                                  <span className="text-[10px] text-slate-500 block">
                                    {watchlisted.length === 1
                                      ? `${watchlisted[0].name}${watchlisted[0].watchListReason ? ` — ${watchlisted[0].watchListReason}` : ' is flag-marked.'}`
                                      : `${watchlisted.length} customers are flag-marked and require review.`}
                                  </span>
                                </div>
                              </div>
                            )}
                            {overdueAlerts.overdueCount > 0 && topOverdue && (
                              <div className="flex items-start space-x-2.5 p-2 rounded-xl bg-red-500/5 border border-red-500/10">
                                <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" />
                                <div>
                                  <p className="text-[11px] font-bold text-slate-800 dark:text-slate-200">Late Return{overdueAlerts.overdueCount !== 1 ? 's' : ''}</p>
                                  <span className="text-[10px] text-slate-500 block">
                                    {overdueAlerts.overdueCount === 1
                                      ? `${topOverdue.customerName}'s order ${topOverdue.companyOrderNumber} overdue by ${topOverdue.daysOverdue}d.`
                                      : `${overdueAlerts.overdueCount} orders overdue, including ${topOverdue.customerName}'s ${topOverdue.companyOrderNumber}.`}
                                  </span>
                                </div>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="pt-2">
                    <button 
                      onClick={() => setActiveTab('bookings')}
                      className="w-full py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-slate-700 dark:text-slate-300 font-bold text-[11px] rounded-xl transition-all duration-200 active-shrink text-center"
                    >
                      Audit Active Bookings
                    </button>
                  </div>
                </div>
              </div>

              {/* Overdue Return Alerts Panel */}
              {overdueAlerts.overdueCount > 0 && (
                <div className="bg-neo shadow-neo-outset border border-red-500/20 rounded-2xl p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 rounded-xl bg-red-500/10 flex items-center justify-center">
                        <AlertTriangle size={16} className="text-red-500" />
                      </div>
                      <div>
                        <h3 className="text-xs font-black text-red-600 dark:text-red-400 uppercase tracking-wider">Overdue Returns</h3>
                        <p className="text-[10px] text-slate-500">{overdueAlerts.overdueCount} order{overdueAlerts.overdueCount !== 1 ? 's' : ''} past expected return date</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-slate-400 uppercase font-bold">Total Projected Fees</p>
                      <p className="text-sm font-black text-red-600 dark:text-red-400 font-mono">{companyCurrency} {overdueAlerts.totalProjectedFees.toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="space-y-2 max-h-56 overflow-y-auto">
                    {overdueAlerts.orders.map(order => (
                      <div key={order.id} className="flex items-center justify-between bg-red-500/5 border border-red-500/10 rounded-xl px-4 py-2.5">
                        <div className="flex items-center space-x-3">
                          <div className="flex flex-col">
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-200 font-mono">{order.companyOrderNumber}</span>
                            <span className="text-[10px] text-slate-500">{order.customerName}</span>
                          </div>
                        </div>
                        <div className="flex items-center space-x-4">
                          <div className="text-center">
                            <p className="text-[9px] text-slate-400 uppercase font-bold">Days Late</p>
                            <span className="text-xs font-black text-red-600 dark:text-red-400">{order.daysOverdue}d</span>
                          </div>
                          <div className="text-center">
                            <p className="text-[9px] text-slate-400 uppercase font-bold">Projected Fee</p>
                            <span className="text-[11px] font-black text-amber-600 dark:text-amber-400 font-mono">{companyCurrency} {order.projectedLateFee.toLocaleString()}</span>
                          </div>
                          <button
                            onClick={() => handleApplyLateFee(order.id)}
                            disabled={applyingLateFee === order.id}
                            className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold rounded-lg active-shrink cursor-pointer transition-all disabled:opacity-60"
                          >
                            {applyingLateFee === order.id ? '…' : 'Apply Fee'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Accounts Receivable Aging Ledger */}

              <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200/10 pb-2">
                  <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Accounts Receivable Aging Ledger</h3>
                  <span className="text-[10px] text-red-500 font-mono font-bold">Total Unpaid: UGX {Number(agingReport.totalUnpaid).toLocaleString()}</span>
                </div>
                
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 pt-2">
                  {[
                    { label: "Current (Net 30)", value: agingReport.current, color: "text-green-600 dark:text-green-400", bar: "bg-green-500" },
                    { label: "1 - 30 Days Overdue", value: agingReport.overdue1to30, color: "text-blue-500 dark:text-blue-400", bar: "bg-blue-500" },
                    { label: "31 - 60 Days Overdue", value: agingReport.overdue31to60, color: "text-amber-500 dark:text-amber-400", bar: "bg-amber-500" },
                    { label: "61 - 90 Days Overdue", value: agingReport.overdue61to90, color: "text-orange-500 dark:text-orange-400", bar: "bg-orange-500" },
                    { label: "90+ Days Overdue", value: agingReport.overdue90Plus, color: "text-red-500 dark:text-red-400", bar: "bg-red-500" }
                  ].map((bucket, i) => (
                    <div key={i} className="bg-neo shadow-neo-inset-sm p-4 rounded-xl space-y-2 flex flex-col justify-between">
                      <p className="text-[10px] text-slate-500 font-bold uppercase leading-none">{bucket.label}</p>
                      <h4 className="text-xs font-black font-mono tracking-tight text-slate-800 dark:text-slate-200">UGX {Number(bucket.value).toLocaleString()}</h4>
                      <div className="w-full h-1 bg-slate-200/10 rounded-full overflow-hidden">
                        <div className={`h-full ${bucket.bar}`} style={{ width: bucket.value > 0 ? '100%' : '0%' }}></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: BOOKINGS COCKPIT */}
          {activeTab === 'bookings' && (
            <div className="space-y-6">
              {/* Toolbar filters */}
              <div className="bg-neo shadow-neo-outset p-4 rounded-2xl flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center space-x-3 bg-neo shadow-neo-inset-sm px-3.5 py-2 rounded-xl max-w-sm flex-1">
                  <Search size={14} className="text-slate-400 shrink-0" />
                  <input 
                    type="text" 
                    placeholder="Search bookings..." 
                    className="bg-transparent border-none text-xs text-slate-800 dark:text-slate-200 focus:outline-none w-full"
                  />
                </div>
                
                <div className="flex items-center space-x-2">
                  {['all', 'pending', 'confirmed', 'converted', 'cancelled'].map((flt) => (
                    <button
                      key={flt}
                      className="px-3 py-1.5 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 transition-all duration-200"
                    >
                      {flt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bookings List table */}
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                      <th className="p-4">Booking ID</th>
                      <th className="p-4">Customer</th>
                      <th className="p-4">Type</th>
                      <th className="p-4">Pickup Date</th>
                      <th className="p-4">Return Date</th>
                      <th className="p-4 text-right">Total Est</th>
                      <th className="p-4 text-center">Deposit</th>
                      <th className="p-4 text-center">Status</th>
                      <th className="p-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs divide-y divide-slate-200/10">
                    {bookings.map(b => (
                      <tr key={b.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                        <td className="p-4 font-mono font-bold text-slate-700 dark:text-slate-300">{b.bookingNumber}</td>
                        <td className="p-4 font-bold text-slate-800 dark:text-slate-200">{b.customerName}</td>
                        <td className="p-4 capitalize">{b.bookingType}</td>
                        <td className="p-4 font-mono">{b.scheduledPickupDate}</td>
                        <td className="p-4 font-mono">{b.scheduledReturnDate}</td>
                        <td className="p-4 text-right font-mono font-bold text-green-600 dark:text-green-400">UGX {b.estimatedTotalCost.toLocaleString()}</td>
                        <td className="p-4 text-center">
                          {b.depositPaid ? (
                            <span className="text-[10px] font-bold text-green-600 bg-green-500/10 px-2 py-0.5 rounded-full">Paid</span>
                          ) : (
                            <button 
                              onClick={() => {
                                if (!can('bookings', 'edit')) {
                                  alert("Access Restricted: your role can't record booking deposits.");
                                  return;
                                }
                                handleConfirmDeposit(b.id);
                              }}
                              className="px-2 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-amber-600 dark:text-amber-400 rounded-lg active-shrink transition-all cursor-pointer font-medium"
                            >
                              Collect UGX {b.depositAmount.toLocaleString()}
                            </button>
                          )}
                        </td>
                        <td className="p-4 text-center">
                          <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full border ${
                            b.status === 'confirmed' ? 'text-green-600 bg-green-500/10 border-green-500/20' :
                            b.status === 'pending' ? 'text-amber-500 bg-amber-500/10 border-amber-500/20' :
                            'text-slate-500 bg-slate-500/10 border-slate-500/20'
                          }`}>
                            {b.status}
                          </span>
                        </td>
                        <td className="p-4 text-right space-x-2">
                          <button
                            onClick={() => setActiveBookingToPrint(b)}
                            className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-slate-600 dark:text-slate-400 rounded-lg active-shrink transition-all cursor-pointer font-medium"
                          >
                            Receipt
                          </button>
                          {(b.status === 'confirmed' || (b.status === 'pending' && b.depositPaid)) && (
                            <button
                              onClick={() => {
                                if (!can('dispatches', 'create')) {
                                  alert("Access Restricted: your role can't dispatch bookings to active rental orders.");
                                  return;
                                }
                                handleDispatchBooking(b);
                              }}
                              className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] rounded-lg active-shrink transition-all cursor-pointer font-medium"
                            >
                              Dispatch Order
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: DISPATCHES & RETURNS */}
          {activeTab === 'dispatches' && (
            <div className="space-y-6">
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                      <th className="p-4">Order ID</th>
                      <th className="p-4">Customer</th>
                      <th className="p-4">Dispatched At</th>
                      <th className="p-4">Expected Return</th>
                      <th className="p-4 text-right">Est. Cost</th>
                      <th className="p-4 text-right">Late Fees</th>
                      <th className="p-4 text-center">Status</th>
                      <th className="p-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs divide-y divide-slate-200/10">
                    {rentalOrders.map(order => {
                        const isOverdue = order.status === 'Overdue';
                        const daysOverdue = isOverdue && !order.actualReturnDate
                          ? Math.max(0, Math.ceil((Date.now() - new Date(order.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)))
                          : 0;
                        return (
                          <tr key={order.id} className={`hover:bg-slate-200/5 dark:hover:bg-slate-800/5 transition-colors ${isOverdue ? 'bg-red-500/[0.02]' : ''}`}>
                            <td className="p-4 font-mono font-bold text-slate-700 dark:text-slate-300">
                              <div className="flex items-center space-x-2">
                                <span>{order.companyOrderNumber}</span>
                                {isOverdue && (
                                  <span className="inline-flex items-center space-x-1 text-[9px] font-black bg-red-500/10 border border-red-500/20 text-red-500 px-1.5 py-0.5 rounded-full">
                                    <span>⚠</span><span>{daysOverdue}d late</span>
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="p-4 font-bold text-slate-800 dark:text-slate-200">{order.customerName}</td>
                            <td className="p-4 font-mono text-xs">{order.checkoutDate}</td>
                            <td className={`p-4 font-mono text-xs ${isOverdue ? 'text-red-500 font-bold' : ''}`}>{order.expectedReturnDate}</td>
                            <td className="p-4 text-right font-mono text-xs">{companyCurrency} {Number(order.estimatedTotal).toLocaleString()}</td>
                            <td className={`p-4 text-right font-mono text-xs font-bold ${Number(order.totalLateFeeCalculated) > 0 ? 'text-red-500' : 'text-slate-400'}`}>
                              {Number(order.totalLateFeeCalculated) > 0 ? `${companyCurrency} ${Number(order.totalLateFeeCalculated).toLocaleString()}` : '—'}
                            </td>
                            <td className="p-4 text-center">
                              <span className={`text-[10px] font-extrabold uppercase px-2.5 py-0.5 rounded-full ${
                                order.status === 'Overdue' ? 'text-red-600 bg-red-500/10 border border-red-500/20' :
                                order.status === 'Active' ? 'text-amber-500 bg-amber-500/10 border border-amber-500/20' :
                                'text-green-600 bg-green-500/10 border border-green-500/20'
                              }`}>
                                {order.status}
                              </span>
                            </td>
                            <td className="p-4 text-right">
                              <div className="flex items-center justify-end space-x-2">
                                <button
                                  onClick={() => openServerPdf(`/api/rental-orders/${order.id}/pdf`)}
                                  className="px-3 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-slate-600 dark:text-slate-400 rounded-lg active-shrink transition-all"
                                >
                                  PDF
                                </button>
                                {(order.status === 'Active' || order.status === 'Overdue' || order.status === 'Partially Returned') && (
                                  <button
                                    onClick={() => openReturnModal(order)}
                                    className="px-3 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all"
                                  >
                                    Process Return
                                  </button>
                                )}
                                {order.status === 'Overdue' && (
                                  <button
                                    onClick={() => handleApplyLateFee(order.id)}
                                    disabled={applyingLateFee === order.id}
                                    className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold rounded-lg active-shrink cursor-pointer transition-all disabled:opacity-60"
                                  >
                                    {applyingLateFee === order.id ? '…' : 'Apply Fee'}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}

                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* RETURN RECONCILIATION MODAL */}
          {returnOrder && (() => {
            const rentable = (returnOrder.lineItems || []).filter(li => li.itemType !== 'consumable');
            const preview = returnFeePreview();
            const hasLines = rentable.length > 0;
            return (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !processingReturn && setReturnOrder(null)}>
                <div className="bg-neo shadow-neo-outset border border-slate-200/10 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 space-y-5" onClick={e => e.stopPropagation()}>
                  <div className="flex justify-between items-start border-b border-slate-200/10 pb-3">
                    <div>
                      <h3 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase">Process Return &amp; Reconcile</h3>
                      <p className="text-[11px] text-slate-500 mt-0.5 font-mono">{returnOrder.companyOrderNumber} · {returnOrder.customerName}</p>
                    </div>
                    <button onClick={() => setReturnOrder(null)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">✕</button>
                  </div>

                  {!hasLines ? (
                    <div className="text-center py-8 text-xs text-slate-500">
                      This order has no tracked rentable line items to reconcile. Confirm the return to close it out.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="grid grid-cols-12 gap-2 text-[9px] uppercase font-black text-slate-500 px-1">
                        <div className="col-span-5">Item</div>
                        <div className="col-span-1 text-center">Out</div>
                        <div className="col-span-2 text-center text-green-600">Good</div>
                        <div className="col-span-2 text-center text-amber-500">Damaged</div>
                        <div className="col-span-2 text-center text-red-500">Lost</div>
                      </div>
                      {rentable.map(li => {
                        const outstanding = (li.rentedQty || 0) - (li.returnedQty + li.damagedQty + li.lostQty);
                        const l = returnLines[li.id] || { returned: 0, damaged: 0, lost: 0 };
                        const repl = li.itemType === 'asset' ? Number(li.asset?.replacementCost || 0) : Number(li.item?.unitReplacementCost || 0);
                        const over = l.returned + l.damaged + l.lost > outstanding;
                        const setVal = (k: 'returned' | 'damaged' | 'lost', v: number) =>
                          setReturnLines(prev => ({ ...prev, [li.id]: { ...l, [k]: Math.max(0, v || 0) } }));
                        return (
                          <div key={li.id} className={`grid grid-cols-12 gap-2 items-center bg-neo shadow-neo-inset-sm rounded-xl p-2 border ${over ? 'border-red-500/40' : 'border-transparent'}`}>
                            <div className="col-span-5">
                              <p className="text-[11px] font-bold text-slate-800 dark:text-slate-200 truncate">{li.item?.name || li.asset?.name || 'Item'}</p>
                              <p className="text-[9px] text-slate-500 uppercase">{li.itemType}{li.asset?.serialNumber ? ` · ${li.asset.serialNumber}` : ''} · repl {companyCurrency} {repl.toLocaleString()}</p>
                            </div>
                            <div className="col-span-1 text-center font-mono text-[11px] font-bold text-slate-600 dark:text-slate-400">{outstanding}</div>
                            {(['returned', 'damaged', 'lost'] as const).map(k => (
                              <div key={k} className="col-span-2">
                                <input type="number" min={0} max={outstanding} value={(l as any)[k] || ''}
                                  onChange={e => setVal(k, parseInt(e.target.value))}
                                  className="w-full bg-neo shadow-neo-inset-sm border-none p-1.5 rounded-lg text-[11px] text-center text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Reconciliation notes (optional)</label>
                    <textarea value={returnNotes} onChange={e => setReturnNotes(e.target.value)} rows={2}
                      placeholder="e.g. 2 chairs cracked, 1 missing after event"
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                  </div>

                  <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-[9px] uppercase font-black text-slate-500">Late Fee{preview.daysOverdue > 0 ? ` · ${preview.daysOverdue}d` : ''}</p>
                      <p className={`text-sm font-black font-mono ${preview.late > 0 ? 'text-red-500' : 'text-slate-400'}`}>{companyCurrency} {preview.late.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase font-black text-slate-500">Damage / Loss</p>
                      <p className={`text-sm font-black font-mono ${preview.damage > 0 ? 'text-amber-500' : 'text-slate-400'}`}>{companyCurrency} {preview.damage.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase font-black text-slate-500">Total Charges</p>
                      <p className="text-sm font-black font-mono text-slate-800 dark:text-slate-200">{companyCurrency} {(preview.late + preview.damage).toLocaleString()}</p>
                    </div>
                  </div>
                  <p className="text-[9px] text-slate-400 text-center">Fee rates are set in Settings → Business Settings. Charges post to the customer ledger and generate penalty invoices.</p>

                  <div className="flex justify-end space-x-2 pt-1">
                    <button onClick={() => setReturnOrder(null)} disabled={processingReturn}
                      className="px-4 py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-300 rounded-xl active-shrink transition-all disabled:opacity-50">Cancel</button>
                    <button onClick={handleSubmitReturn} disabled={processingReturn}
                      className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink transition-all disabled:opacity-60">
                      {processingReturn ? 'Processing…' : 'Confirm Return'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* TAB 4: INVOICES */}
          {activeTab === 'invoices' && (
            <div className="space-y-6">
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                      <th className="p-4">Invoice #</th>
                      <th className="p-4">Customer</th>
                      <th className="p-4">Details</th>
                      <th className="p-4">Due Date</th>
                      <th className="p-4 text-right">Net</th>
                      <th className="p-4 text-right">Tax</th>
                      <th className="p-4 text-right">Total</th>
                      <th className="p-4 text-right">Balance</th>
                      <th className="p-4 text-center">Status</th>
                      <th className="p-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs divide-y divide-slate-200/10">
                    {invoices.map(inv => {
                      const lines = inv.lineItems || [];
                      const expanded = expandedInvoiceId === inv.id;
                      const balance = inv.balanceDue ?? (Number(inv.amount) - Number(inv.amountPaid || 0));
                      const sym = inv.currency || bizSettings.currency;
                      return (
                        <Fragment key={inv.id}>
                          <tr className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                            <td className="p-4 font-mono font-bold text-slate-700 dark:text-slate-300">
                              {lines.length > 0 && (
                                <button
                                  onClick={() => setExpandedInvoiceId(expanded ? null : inv.id)}
                                  className="mr-1.5 text-slate-400 hover:text-blue-600 cursor-pointer align-middle"
                                  title={expanded ? 'Hide line items' : `Show ${lines.length} line item(s)`}
                                >
                                  {expanded ? <ChevronDown size={12} className="inline" /> : <ChevronRight size={12} className="inline" />}
                                </button>
                              )}
                              {inv.referenceNumber}
                            </td>
                            <td className="p-4 font-bold text-slate-800 dark:text-slate-200">
                              {inv.customerName}
                              {inv.customerTin && <span className="block text-[9px] text-slate-400 font-mono font-normal">TIN {inv.customerTin}</span>}
                            </td>
                            <td className="p-4 text-slate-500">
                              <p>{inv.description}</p>
                              {inv.paymentMethod && Number(inv.amountPaid) > 0 && (
                                <span className="text-[10px] text-green-600 dark:text-green-400 block mt-0.5 font-medium">
                                  {fmtMoney(inv.amountPaid, sym)} via {inv.paymentMethod}{inv.paymentDate ? ` on ${inv.paymentDate.split('T')[0]}` : ''}
                                </span>
                              )}
                              {inv.efrisStatus === 'FAILED' && inv.efrisError && (
                                <span className="text-[10px] text-red-500 block mt-0.5">URA rejected it: {inv.efrisError}</span>
                              )}
                            </td>
                            <td className="p-4 font-mono">{String(inv.dueDate).split('T')[0]}</td>
                            <td className="p-4 text-right font-mono text-slate-500">{Number(inv.subtotal || 0).toLocaleString()}</td>
                            <td className="p-4 text-right font-mono text-slate-500">{Number(inv.taxTotal || 0).toLocaleString()}</td>
                            <td className="p-4 text-right font-mono font-bold text-slate-900 dark:text-white">
                              {fmtMoney(inv.amount, sym)}
                            </td>
                            <td className="p-4 text-right font-mono font-bold text-slate-600 dark:text-slate-400">
                              {balance > 0 ? Number(balance).toLocaleString() : '—'}
                            </td>
                            <td className="p-4 text-center space-y-1">
                              <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full block ${
                                inv.status === 'Paid' ? 'text-green-600 bg-green-500/10' :
                                inv.status === 'Credited' ? 'text-slate-500 bg-slate-500/10' :
                                inv.status === 'Part Paid' ? 'text-amber-600 bg-amber-500/10' :
                                'text-red-500 bg-red-500/10'
                              }`}>
                                {inv.status}
                              </span>
                              {inv.efrisFDN && (
                                <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full text-blue-600 bg-blue-500/10 block" title={`FDN ${inv.efrisFDN}`}>
                                  Fiscalized
                                </span>
                              )}
                            </td>
                            <td className="p-4 text-right space-x-2 whitespace-nowrap">
                              <button
                                onClick={() => setActiveInvoiceToPrint(inv)}
                                className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-slate-600 dark:text-slate-400 rounded-lg active-shrink transition-all cursor-pointer font-medium"
                              >
                                Print
                              </button>
                              <button
                                onClick={() => openServerPdf(`/api/invoices/${inv.id}/pdf`)}
                                className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all cursor-pointer font-medium"
                              >
                                PDF
                              </button>
                              {efrisConfig.enabled && efrisConfig.configured && (
                                <button
                                  onClick={() => fiscalizeInvoice(inv)}
                                  disabled={fiscalizingId === inv.id}
                                  className={`px-2.5 py-1 text-[10px] font-bold rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-50 ${
                                    inv.efrisFDN
                                      ? 'bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-blue-600 dark:text-blue-400'
                                      : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                  }`}
                                  title={inv.efrisFDN ? 'View the URA fiscal invoice' : 'Report this invoice to URA'}
                                >
                                  {fiscalizingId === inv.id ? 'Sending…' : inv.efrisFDN ? 'Fiscal Invoice' : 'Fiscalize'}
                                </button>
                              )}
                              {inv.status !== 'Paid' && inv.status !== 'Credited' && (
                                <>
                                  <button
                                    onClick={() => {
                                      setPayInvoiceId(inv.id);
                                      setPayInvoiceDate(new Date().toISOString().split('T')[0]);
                                      setShowPayInvoiceModal(true);
                                    }}
                                    className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-[10px] font-bold text-white rounded-lg active-shrink transition-all cursor-pointer font-medium"
                                  >
                                    Record Pay
                                  </button>
                                  <button
                                    onClick={() => handleIssueCreditNote(inv)}
                                    className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-amber-600 dark:text-amber-400 rounded-lg active-shrink transition-all cursor-pointer font-medium"
                                  >
                                    Credit Memo
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                          {expanded && (
                            <tr className="bg-slate-200/5 dark:bg-slate-800/10">
                              <td colSpan={10} className="px-8 py-4">
                                <table className="w-full text-left">
                                  <thead>
                                    <tr className="text-[9px] uppercase font-black text-slate-500 border-b border-slate-200/10">
                                      <th className="py-1.5 pr-3">Item</th>
                                      <th className="py-1.5 px-2 text-right">Qty</th>
                                      <th className="py-1.5 px-2 text-right">Days</th>
                                      <th className="py-1.5 px-2 text-right">Rate (net)</th>
                                      <th className="py-1.5 px-2 text-right">Net</th>
                                      <th className="py-1.5 px-2 text-right">Tax</th>
                                      <th className="py-1.5 pl-2 text-right">Total</th>
                                    </tr>
                                  </thead>
                                  <tbody className="text-[11px] divide-y divide-slate-200/10">
                                    {lines.map((l: InvoiceLine) => (
                                      <tr key={l.id}>
                                        <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300">
                                          {l.description}
                                          {l.unitOfMeasure && <span className="text-slate-400 ml-1">({l.unitOfMeasure.abbreviation})</span>}
                                        </td>
                                        <td className="py-1.5 px-2 text-right font-mono">{Number(l.quantity)}</td>
                                        <td className="py-1.5 px-2 text-right font-mono">{l.rentalDays}</td>
                                        <td className="py-1.5 px-2 text-right font-mono">{Number(l.unitPrice).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                                        <td className="py-1.5 px-2 text-right font-mono">{Number(l.lineNet).toLocaleString()}</td>
                                        <td className="py-1.5 px-2 text-right font-mono">{Number(l.lineTax).toLocaleString()}</td>
                                        <td className="py-1.5 pl-2 text-right font-mono font-bold">{Number(l.lineTotal).toLocaleString()}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: CREDIT NOTES */}
          {activeTab === 'creditNotes' && (
            <div className="space-y-6">
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                      <th className="p-4">Credit Note #</th>
                      <th className="p-4">Against Invoice</th>
                      <th className="p-4">Customer</th>
                      <th className="p-4">Reason</th>
                      <th className="p-4">Issued At</th>
                      <th className="p-4 text-right">Net</th>
                      <th className="p-4 text-right">Tax</th>
                      <th className="p-4 text-right">Credited</th>
                      <th className="p-4 text-center">URA</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs divide-y divide-slate-200/10">
                    {creditNotes.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="p-8 text-center text-slate-400">
                          No credit notes issued yet.
                        </td>
                      </tr>
                    ) : (
                      creditNotes.map(note => (
                        <tr key={note.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                          <td className="p-4 font-mono font-bold text-slate-700 dark:text-slate-300">{note.referenceNumber}</td>
                          <td className="p-4 font-mono text-slate-500">{note.invoice?.referenceNumber || '—'}</td>
                          <td className="p-4 font-bold text-slate-800 dark:text-slate-200">{note.customerName}</td>
                          <td className="p-4 text-slate-500">
                            {note.reason}
                            {note.reasonLabel && <span className="block text-[9px] text-slate-400 mt-0.5">URA: {note.reasonLabel}</span>}
                          </td>
                          <td className="p-4 font-mono">{String(note.createdAt).split('T')[0]}</td>
                          <td className="p-4 text-right font-mono text-slate-500">{Number(note.subtotal || 0).toLocaleString()}</td>
                          <td className="p-4 text-right font-mono text-slate-500">{Number(note.taxTotal || 0).toLocaleString()}</td>
                          <td className="p-4 text-right font-mono font-bold text-green-600 dark:text-green-400">
                            {fmtMoney(note.amount, bizSettings.currency)}
                          </td>
                          <td className="p-4 text-center">
                            {note.efrisFDN ? (
                              <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full text-blue-600 bg-blue-500/10" title={`FDN ${note.efrisFDN}`}>
                                Fiscalized
                              </span>
                            ) : note.canFiscalize && efrisConfig.enabled && efrisConfig.configured ? (
                              <button
                                onClick={() => fiscalizeCreditNote(note)}
                                disabled={fiscalizingId === note.id}
                                className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-[9px] font-bold text-white rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-50"
                                title="Report this credit note to URA"
                              >
                                {fiscalizingId === note.id ? 'Sending…' : 'Fiscalize'}
                              </button>
                            ) : (
                              <span className="text-[9px] text-slate-400" title={note.invoice?.efrisFDN ? '' : 'The original invoice was never fiscalized'}>—</span>
                            )}
                            {note.efrisStatus === 'FAILED' && note.efrisError && (
                              <span className="block text-[9px] text-red-500 mt-1">{note.efrisError}</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {/* TAB: CUSTOMERS */}
          {activeTab === 'customers' && (
            <div className="space-y-5">

              {/* Toolbar */}
              <div className="bg-neo shadow-neo-outset p-4 rounded-2xl flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  {/* Search */}
                  <div className="flex items-center space-x-2 bg-neo shadow-neo-inset-sm px-3 py-2 rounded-xl w-56">
                    <Search size={13} className="text-slate-400 shrink-0" />
                    <input
                      type="text"
                      placeholder="Search by name or contact…"
                      value={custSearch}
                      onChange={e => setCustSearch(e.target.value)}
                      className="bg-transparent text-xs text-slate-700 dark:text-slate-300 focus:outline-none placeholder:text-slate-400 w-full"
                    />
                  </div>

                  {/* Filter pills */}
                  {(['all', 'watchlisted', 'clear'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setWatchlistFilter(f)}
                      className={`px-3 py-1.5 rounded-xl text-[11px] font-bold transition-all active-shrink capitalize ${
                        watchlistFilter === f
                          ? 'bg-blue-600 text-white shadow-lg'
                          : 'bg-neo shadow-neo-outset-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                    >
                      {f === 'all' ? 'All' : f === 'watchlisted' ? '⚠ Watchlisted' : '✓ Clear'}
                    </button>
                  ))}
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => {
                      setImportTarget('customers');
                      setShowImportModal(true);
                    }}
                    className="bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs px-3 py-2.5 rounded-xl active-shrink transition-all cursor-pointer font-medium"
                    title="Import Customers from CSV"
                  >
                    Import CSV
                  </button>
                  <button
                    onClick={() => handleExportCSV('customers')}
                    className="bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs px-3 py-2.5 rounded-xl active-shrink transition-all cursor-pointer font-medium"
                    title="Export Customers to CSV"
                  >
                    Export CSV
                  </button>
                  <button
                    onClick={() => setShowCustomerModal(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer font-medium"
                  >
                    <Plus size={14} />
                    <span>New Customer</span>
                  </button>
                </div>
              </div>

              {/* Summary stats */}
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Total Customers', value: customers.length, color: 'text-blue-600 dark:text-blue-400' },
                  { label: 'Watchlisted', value: customers.filter(c => c.isOnWatchList).length, color: 'text-amber-500' },
                  { label: 'Active Renters', value: customers.filter(c => (c._count?.rentalOrders ?? 0) > 0).length, color: 'text-green-600 dark:text-green-400' }
                ].map((stat, i) => (
                  <div key={i} className="bg-neo shadow-neo-outset p-4 rounded-2xl flex flex-col space-y-1">
                    <p className="text-[10px] font-bold text-slate-500 uppercase">{stat.label}</p>
                    <h3 className={`text-2xl font-black font-mono ${stat.color}`}>{stat.value}</h3>
                  </div>
                ))}
              </div>

              {/* Customer Table */}
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200/10">
                      {['Customer', 'Contact Info', 'Bookings', 'Rentals', 'Status', 'Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-[10px] font-bold uppercase text-slate-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {customers
                      .filter(c => {
                        const matchSearch = custSearch === '' ||
                          c.name.toLowerCase().includes(custSearch.toLowerCase()) ||
                          c.contactInfo.toLowerCase().includes(custSearch.toLowerCase());
                        const matchFilter =
                          watchlistFilter === 'all' ||
                          (watchlistFilter === 'watchlisted' && c.isOnWatchList) ||
                          (watchlistFilter === 'clear' && !c.isOnWatchList);
                        return matchSearch && matchFilter;
                      })
                      .map(customer => (
                        <tr key={customer.id} className={`border-b border-slate-200/5 transition-colors hover:bg-white/3 ${customer.isOnWatchList ? 'bg-amber-500/5' : ''}`}>
                          <td className="px-4 py-3">
                            <div className="flex items-center space-x-2.5">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black shadow-neo-outset-sm ${customer.isOnWatchList ? 'bg-amber-500/10 text-amber-600' : 'bg-blue-500/10 text-blue-600'}`}>
                                {customer.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                              </div>
                              <div>
                                <p className="text-xs font-bold text-slate-800 dark:text-slate-200">{customer.name}</p>
                                {customer.isOnWatchList && (
                                  <span className="text-[9px] font-bold text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded-full">
                                    ⚠ Watchlisted
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-[11px] text-slate-500 max-w-[180px] truncate">
                            {customer.contactInfo || '—'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="bg-neo shadow-neo-inset-sm text-[11px] font-mono font-bold text-slate-700 dark:text-slate-300 px-2 py-1 rounded-lg">
                              {customer._count?.bookings ?? 0}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="bg-neo shadow-neo-inset-sm text-[11px] font-mono font-bold text-slate-700 dark:text-slate-300 px-2 py-1 rounded-lg">
                              {customer._count?.rentalOrders ?? 0}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                              customer.isOnWatchList
                                ? 'bg-amber-500/15 text-amber-600'
                                : 'bg-green-500/15 text-green-600 dark:text-green-400'
                            }`}>
                              {customer.isOnWatchList ? 'Watch List' : 'Active'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center space-x-2">
                              <button
                                onClick={() => handleViewCustomerHistory(customer.id)}
                                title="View rental history"
                                className="p-1.5 rounded-lg bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 hover:text-blue-600 transition-all active-shrink"
                              >
                                <History size={13} />
                              </button>
                              <button
                                onClick={() => handleToggleWatchlist(customer)}
                                title={customer.isOnWatchList ? 'Remove from watchlist' : 'Add to watchlist'}
                                className={`p-1.5 rounded-lg bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm transition-all active-shrink ${
                                  customer.isOnWatchList ? 'text-amber-500 hover:text-green-600' : 'text-slate-500 hover:text-amber-500'
                                }`}
                              >
                                {customer.isOnWatchList ? <ShieldOff size={13} /> : <ShieldAlert size={13} />}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    {customers.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center text-xs text-slate-400">
                          No customers found. Click "New Customer" to add the first one.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Customer History Drawer */}
              {customerHistoryId && customerHistory && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                  <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-2xl space-y-5 max-h-[80vh] overflow-y-auto">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-black text-slate-800 dark:text-white">{customerHistory.name}</h3>
                        <p className="text-[11px] text-slate-500">{customerHistory.contactInfo}</p>
                      </div>
                      <button
                        onClick={() => { setCustomerHistoryId(null); setCustomerHistory(null); }}
                        className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink"
                      >
                        <X size={14} />
                      </button>
                    </div>

                    {/* Rental Orders */}
                    <div className="space-y-2">
                      <h4 className="text-[10px] font-bold text-slate-500 uppercase border-b border-slate-200/10 pb-1.5">
                        Rental Orders ({customerHistory.rentalOrders?.length ?? 0})
                      </h4>
                      {(customerHistory.rentalOrders ?? []).length === 0 && (
                        <p className="text-[11px] text-slate-400">No rental orders found.</p>
                      )}
                      {(customerHistory.rentalOrders ?? []).map((order: any) => (
                        <div key={order.id} className="bg-neo shadow-neo-inset-sm p-3 rounded-xl flex items-center justify-between">
                          <div>
                            <p className="text-xs font-bold text-slate-700 dark:text-slate-300">{order.companyOrderNumber}</p>
                            <span className="text-[10px] text-slate-500">
                              {order.checkoutDate?.split('T')[0]} → {order.expectedReturnDate?.split('T')[0]}
                            </span>
                          </div>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            order.status === 'Active' ? 'bg-blue-500/15 text-blue-600' :
                            order.status === 'Returned' ? 'bg-green-500/15 text-green-600' :
                            'bg-slate-500/15 text-slate-500'
                          }`}>{order.status}</span>
                        </div>
                      ))}
                    </div>

                    {/* Bookings */}
                    <div className="space-y-2">
                      <h4 className="text-[10px] font-bold text-slate-500 uppercase border-b border-slate-200/10 pb-1.5">
                        Bookings ({customerHistory.bookings?.length ?? 0})
                      </h4>
                      {(customerHistory.bookings ?? []).length === 0 && (
                        <p className="text-[11px] text-slate-400">No bookings found.</p>
                      )}
                      {(customerHistory.bookings ?? []).map((booking: any) => (
                        <div key={booking.id} className="bg-neo shadow-neo-inset-sm p-3 rounded-xl flex items-center justify-between">
                          <div>
                            <p className="text-xs font-bold text-slate-700 dark:text-slate-300">{booking.bookingNumber}</p>
                            <span className="text-[10px] text-slate-500">
                              Est. Total: UGX {Number(booking.estimatedTotalCost).toLocaleString()}
                            </span>
                          </div>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${
                            booking.status === 'confirmed' ? 'bg-green-500/15 text-green-600' :
                            booking.status === 'pending' ? 'bg-blue-500/15 text-blue-600' :
                            'bg-slate-500/15 text-slate-500'
                          }`}>{booking.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB: CUSTOMER LEDGERS */}
          {activeTab === 'ledgers' && (
            <div className="space-y-6">
              {/* Toolbar */}
              <div className="bg-neo shadow-neo-outset p-4 rounded-2xl flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  {/* Search */}
                  <div className="flex items-center space-x-2 bg-neo shadow-neo-inset-sm px-3 py-2 rounded-xl w-64">
                    <Search size={13} className="text-slate-400 shrink-0" />
                    <input
                      type="text"
                      placeholder="Search by customer name…"
                      value={ledgerSearch}
                      onChange={e => setLedgerSearch(e.target.value)}
                      className="bg-transparent text-xs text-slate-700 dark:text-slate-300 focus:outline-none placeholder:text-slate-400 w-full"
                    />
                  </div>
                </div>

                <div className="flex items-center space-x-3">
                  <button
                    onClick={handleRecalculateAccounts}
                    disabled={recalculatingAccounts}
                    className="flex items-center space-x-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer transition-all disabled:opacity-50"
                  >
                    <span>🔄</span>
                    <span>{recalculatingAccounts ? 'Recalculating...' : 'Recalculate Accounts'}</span>
                  </button>
                </div>
              </div>

              {/* Accounts List */}
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                      <th className="p-4">Customer Name</th>
                      <th className="p-4 text-right">Credit Limit</th>
                      <th className="p-4 text-right">Outstanding Balance</th>
                      <th className="p-4 text-right">Overdue Balance</th>
                      <th className="p-4">Credit Utilization</th>
                      <th className="p-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs divide-y divide-slate-200/10">
                    {customerAccounts
                      .filter(acc => acc.customerName.toLowerCase().includes(ledgerSearch.toLowerCase()))
                      .map(acc => {
                        const outstanding = Number(acc.totalOutstanding);
                        const overdue = Number(acc.totalOverdue);
                        const limit = Number(acc.creditLimit);
                        const utilPercent = limit > 0 ? Math.min(100, Math.round((outstanding / limit) * 100)) : 0;
                        const isOverLimit = limit > 0 && outstanding > limit;

                        return (
                          <tr key={acc.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                            <td className="p-4 font-bold text-slate-800 dark:text-slate-200">
                              <div className="flex items-center space-x-2">
                                <span>{acc.customerName}</span>
                                {acc.isOnWatchList && (
                                  <span className="text-[9px] bg-red-500/10 border border-red-500/20 text-red-500 px-1.5 py-0.5 rounded-full font-bold">Watchlisted</span>
                                )}
                              </div>
                            </td>
                            <td className="p-4 text-right font-mono font-bold">
                              {limit > 0 ? `${companyCurrency} ${limit.toLocaleString()}` : <span className="text-slate-400 italic">No Limit</span>}
                            </td>
                            <td className={`p-4 text-right font-mono font-bold ${outstanding > 0 ? 'text-red-500' : 'text-green-600'}`}>
                              {companyCurrency} {outstanding.toLocaleString()}
                            </td>
                            <td className={`p-4 text-right font-mono font-bold ${overdue > 0 ? 'text-amber-500' : 'text-slate-400'}`}>
                              {overdue > 0 ? `${companyCurrency} ${overdue.toLocaleString()}` : '—'}
                            </td>
                            <td className="p-4 w-48">
                              {limit > 0 ? (
                                <div className="space-y-1">
                                  <div className="h-1.5 w-full bg-slate-200/20 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full transition-all duration-300 ${isOverLimit ? 'bg-red-500' : utilPercent > 80 ? 'bg-amber-500' : 'bg-blue-600'}`}
                                      style={{ width: `${utilPercent}%` }}
                                    />
                                  </div>
                                  <div className="flex items-center justify-between text-[9px] font-bold">
                                    <span className={isOverLimit ? 'text-red-500' : 'text-slate-500'}>{utilPercent}% Used</span>
                                    <span>{companyCurrency} {outstanding.toLocaleString()} / {limit.toLocaleString()}</span>
                                  </div>
                                </div>
                              ) : (
                                <span className="text-slate-400 text-[10px]">Unlimited Credit</span>
                              )}
                            </td>
                            <td className="p-4 text-right">
                              <div className="flex items-center justify-end space-x-2">
                                <button
                                  onClick={() => {
                                    fetchAccountDetails(acc.customerId);
                                    setShowAccountModal(true);
                                  }}
                                  className="px-3 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all"
                                >
                                  View Ledger
                                </button>
                                <button
                                  onClick={async () => {
                                    try {
                                      const headers = { 'x-company-id': selectedCompanyId.toString() };
                                      const res = await fetch(`${API_URL}/api/customer-accounts/${acc.customerId}`, { headers });
                                      if (!res.ok) throw new Error('Failed to load account for statement.');
                                      const data = await res.json();
                                      setActiveStatementToPrint(data);
                                    } catch (err: any) { alert(err.message); }
                                  }}
                                  className="px-3 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-slate-600 dark:text-slate-400 rounded-lg active-shrink transition-all"
                                >
                                  Print Statement
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    {customerAccounts.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-slate-400 font-medium">
                          No ledger accounts initialized. Click "Recalculate Accounts" above to backfill.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB: SCHEDULING & STAFF */}
          {activeTab === 'scheduling' && (
            <div className="space-y-6">
              
              {/* ⚠️ 2-Day Pre-Event Equipment Shortage Alerts */}
              {functionAlerts.length > 0 && (
                <div className="bg-neo shadow-neo-outset border border-red-500/20 p-4 rounded-2xl bg-red-500/5 space-y-2">
                  <div className="flex items-center space-x-2 text-red-600 dark:text-red-400">
                    <span>🚨</span>
                    <span className="text-xs font-black uppercase tracking-wider">Pre-Event Equipment Shortage Warnings (2 Days to Event)</span>
                  </div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400 space-y-1">
                    {functionAlerts.map(alert => (
                      <div key={alert.id} className="flex items-center space-x-1.5 font-medium">
                        <span>•</span>
                        <span>
                          Event <strong>"{alert.functionName}"</strong>: {alert.message}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Sub Navigation Bar */}
              <div className="bg-neo shadow-neo-outset p-4 rounded-2xl flex items-center justify-between">
                <div className="flex space-x-3">
                  {([
                    { id: 'roster', label: 'Staff Roster' },
                    { id: 'sites', label: 'Client Sites' },
                    { id: 'events', label: 'Event Planner' }
                  ] as const).map(sub => (
                    <button
                      key={sub.id}
                      onClick={() => setSchedSubTab(sub.id)}
                      className={`px-4 py-2 rounded-xl text-xs font-bold transition-all active-shrink ${
                        schedSubTab === sub.id
                          ? 'bg-blue-600 text-white shadow-lg'
                          : 'bg-neo shadow-neo-outset-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>

                {/* Toolbar Context Actions */}
                <div>
                  {schedSubTab === 'roster' && (
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => { setImportTarget('employees'); setShowImportModal(true); }}
                        className="bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs px-3 py-2.5 rounded-xl active-shrink transition-all cursor-pointer font-medium"
                        title="Import Employees from CSV"
                      >
                        Import CSV
                      </button>
                      <button
                        onClick={() => handleExportCSV('employees')}
                        className="bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs px-3 py-2.5 rounded-xl active-shrink transition-all cursor-pointer font-medium"
                        title="Export Employees to CSV"
                      >
                        Export CSV
                      </button>
                      <button
                        onClick={() => setShowEmployeeModal(true)}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                      >
                        <Plus size={14} />
                        <span>Add Employee</span>
                      </button>
                    </div>
                  )}
                  {schedSubTab === 'sites' && (
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => downloadCsv('/api/export/site-activity', 'site-activity-report.csv')}
                        className="bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs px-3 py-2.5 rounded-xl active-shrink transition-all cursor-pointer"
                        title="Download the site activity report (sites + assigned staff) as CSV"
                      >
                        Site Activity Report
                      </button>
                      <button
                        onClick={() => setShowSiteModal(true)}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                      >
                        <Plus size={14} />
                        <span>Add Job Site</span>
                      </button>
                    </div>
                  )}
                  {schedSubTab === 'events' && (
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => { fetchFunctionTemplates(); setShowTemplatesModal(true); }}
                        className="bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs px-3 py-2.5 rounded-xl active-shrink transition-all cursor-pointer"
                      >
                        Templates
                      </button>
                      <button
                        onClick={() => setShowEventModal(true)}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                      >
                        <Plus size={14} />
                        <span>Plan Event</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* SUB TAB 1: STAFF ROSTER */}
              {schedSubTab === 'roster' && (
                <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200/10 text-[10px] font-bold uppercase text-slate-500">
                        <th className="px-4 py-3">Employee Name</th>
                        <th className="px-4 py-3">Roster Role</th>
                        <th className="px-4 py-3 text-right">Client Rate</th>
                        <th className="px-4 py-3 text-right">Pay Rate</th>
                        <th className="px-4 py-3">Structure</th>
                        <th className="px-4 py-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs divide-y divide-slate-200/10">
                      {employees.map(emp => (
                        <tr key={emp.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                          <td className="px-4 py-3 font-bold text-slate-800 dark:text-slate-200">{emp.name}</td>
                          <td className="px-4 py-3 text-slate-500">{emp.role || '—'}</td>
                          <td className="px-4 py-3 text-right font-mono">UGX {Number(emp.billingRateToClient).toLocaleString()}</td>
                          <td className="px-4 py-3 text-right font-mono">UGX {Number(emp.payRate).toLocaleString()}</td>
                          <td className="px-4 py-3 text-slate-500">{emp.payStructure}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                              emp.isActive ? 'text-green-600 bg-green-500/10' : 'text-slate-500 bg-slate-500/10'
                            }`}>
                              {emp.isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {employees.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-10 text-center text-slate-400">No staff registered.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* SUB TAB 2: CLIENT SITES */}
              {schedSubTab === 'sites' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {sites.map(site => (
                    <div key={site.id} className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl space-y-4 flex flex-col justify-between">
                      <div className="space-y-2">
                        <div className="flex justify-between items-start">
                          <h4 className="text-xs font-black text-slate-800 dark:text-slate-200">{site.name}</h4>
                          <span className="text-[9px] uppercase font-bold text-blue-600 bg-blue-500/10 px-2 py-0.5 rounded-full">Active Site</span>
                        </div>
                        <p className="text-[11px] text-slate-500"><strong className="text-slate-700 dark:text-slate-400">Location:</strong> {site.location || '—'}</p>
                        <p className="text-[11px] text-slate-500"><strong className="text-slate-700 dark:text-slate-400">Contact:</strong> {site.contactPerson} ({site.contactInfo || '—'})</p>
                        {site.notes && <p className="text-[11px] bg-neo shadow-neo-inset-sm p-2 rounded-lg text-slate-500 italic mt-2">"{site.notes}"</p>}
                      </div>

                      <div className="border-t border-slate-200/10 pt-3">
                        <p className="text-[10px] font-bold uppercase text-slate-400 mb-2">Assigned Staff</p>
                        <div className="flex flex-wrap gap-1.5">
                          {(site.siteAssignments || []).map((asn: any) => (
                            <span key={asn.id} className="text-[10px] font-bold bg-neo shadow-neo-inset-sm px-2.5 py-1 rounded-lg text-slate-600 dark:text-slate-300">
                              👤 {asn.employee?.name} {asn.isPrimary && '⭐'}
                            </span>
                          ))}
                          {(site.siteAssignments || []).length === 0 && (
                            <span className="text-[10px] text-slate-400 italic">No assigned staff.</span>
                          )}
                        </div>
                        
                        <div className="flex justify-end pt-3">
                          <button
                            onClick={() => {
                              setAssignSiteId(site.id);
                              setShowAssignSiteModal(true);
                            }}
                            className="text-[10px] font-bold text-blue-600 hover:text-blue-700 flex items-center space-x-1"
                          >
                            <Plus size={11} />
                            <span>Assign Employee</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {sites.length === 0 && (
                    <div className="md:col-span-2 bg-neo shadow-neo-outset p-10 text-center text-slate-400 text-xs">No client sites configured.</div>
                  )}
                </div>
              )}

              {/* SUB TAB 3: EVENT PLANNER */}
              {schedSubTab === 'events' && (
                <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200/10 text-[10px] font-bold uppercase text-slate-500">
                        <th className="px-4 py-3">Event Ceremony</th>
                        <th className="px-4 py-3">Date & Time</th>
                        <th className="px-4 py-3">Location</th>
                        <th className="px-4 py-3">Client Contact</th>
                        <th className="px-4 py-3">Assigned Staff</th>
                        <th className="px-4 py-3 text-center">Status</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs divide-y divide-slate-200/10">
                      {functions.map(fn => (
                        <tr key={fn.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                          <td className="px-4 py-3">
                            <div>
                              <p className="font-bold text-slate-800 dark:text-slate-200">{fn.name}</p>
                              {fn.notes && <span className="text-[10px] text-slate-400 block truncate max-w-[200px]">{fn.notes}</span>}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-bold text-slate-700 dark:text-slate-300">{fn.date}</p>
                            <span className="text-[10px] text-slate-500 block">{fn.time}</span>
                          </td>
                          <td className="px-4 py-3 text-slate-500 truncate max-w-[150px]">{fn.location}</td>
                          <td className="px-4 py-3">
                            <p className="text-slate-700 dark:text-slate-300">{fn.clientName}</p>
                            <span className="text-[10px] text-slate-500 block">{fn.clientContact}</span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col space-y-1">
                              {(fn.functionAssignments || []).map((asn: any) => (
                                <span key={asn.id} className="text-[10px] text-slate-600 dark:text-slate-400">
                                  <strong>{asn.role?.name}:</strong> {asn.employee?.name}
                                </span>
                              ))}
                              {(fn.functionAssignments || []).length === 0 && (
                                <span className="text-[10px] text-slate-400 italic">No staff assigned</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                              fn.status === 'Scheduled' ? 'text-blue-600 bg-blue-500/10' :
                              fn.status === 'Completed' ? 'text-green-600 bg-green-500/10' :
                              'text-red-500 bg-red-500/10'
                            }`}>
                              {fn.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end space-x-2">
                              <button
                                onClick={() => fetchFunctionDetails(fn)}
                                className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-[10px] font-bold text-white rounded-lg active-shrink shadow-md transition-all cursor-pointer"
                              >
                                🎯 Manage Event
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {functions.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-4 py-10 text-center text-slate-400">No events planned.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

            </div>
          )}

          {/* TAB: REVENUE LEDGER */}
          {activeTab === 'revenue' && (
            <div className="space-y-6 animate-fade-in">
              
              {/* Analytics Header Cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-neo shadow-neo-outset p-5 rounded-2xl border border-slate-200/5">
                  <span className="text-[10px] text-slate-500 uppercase font-black tracking-wider">Today's Inflow</span>
                  <h3 className="text-lg font-black text-slate-800 dark:text-white mt-1 font-mono">
                    {activeCompany.currency || 'UGX'} {Number(incomeAnalytics?.todayTotal || 0).toLocaleString()}
                  </h3>
                  <div className="w-full bg-slate-200/20 dark:bg-slate-800/20 h-1.5 rounded-full mt-2 overflow-hidden">
                    <div className="bg-green-500 h-full rounded-full w-[25%]" />
                  </div>
                </div>
                <div className="bg-neo shadow-neo-outset p-5 rounded-2xl border border-slate-200/5">
                  <span className="text-[10px] text-slate-500 uppercase font-black tracking-wider">This Month</span>
                  <h3 className="text-lg font-black text-slate-800 dark:text-white mt-1 font-mono">
                    {activeCompany.currency || 'UGX'} {Number(incomeAnalytics?.monthTotal || 0).toLocaleString()}
                  </h3>
                  <div className="w-full bg-slate-200/20 dark:bg-slate-800/20 h-1.5 rounded-full mt-2 overflow-hidden">
                    <div className="bg-blue-500 h-full rounded-full w-[60%]" />
                  </div>
                </div>
                <div className="bg-neo shadow-neo-outset p-5 rounded-2xl border border-slate-200/5">
                  <span className="text-[10px] text-slate-500 uppercase font-black tracking-wider">This Year</span>
                  <h3 className="text-lg font-black text-slate-800 dark:text-white mt-1 font-mono">
                    {activeCompany.currency || 'UGX'} {Number(incomeAnalytics?.yearTotal || 0).toLocaleString()}
                  </h3>
                  <div className="w-full bg-slate-200/20 dark:bg-slate-800/20 h-1.5 rounded-full mt-2 overflow-hidden">
                    <div className="bg-indigo-500 h-full rounded-full w-[85%]" />
                  </div>
                </div>
                <div className="bg-neo shadow-neo-outset p-5 rounded-2xl border border-slate-200/5">
                  <span className="text-[10px] text-slate-500 uppercase font-black tracking-wider">All-Time Revenue</span>
                  <h3 className="text-lg font-black text-green-600 dark:text-green-400 mt-1 font-mono">
                    {activeCompany.currency || 'UGX'} {Number(incomeAnalytics?.allTimeTotal || 0).toLocaleString()}
                  </h3>
                  <div className="w-full bg-slate-200/20 dark:bg-slate-800/20 h-1.5 rounded-full mt-2 overflow-hidden">
                    <div className="bg-green-600 h-full rounded-full w-full" />
                  </div>
                </div>
              </div>

              {/* Source & Method Visual Breakdown Bars */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                
                {/* Source Breakdown */}
                <div className="bg-neo shadow-neo-outset p-5 rounded-2xl space-y-4">
                  <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-wider">Revenue by Stream / Source</h4>
                  <div className="space-y-3">
                    {Object.entries(incomeAnalytics?.bySource || {}).map(([source, amt]) => {
                      const amount = Number(amt);
                      const total = incomeAnalytics?.allTimeTotal || 1;
                      const percent = Math.round((amount / total) * 100);
                      const label = 
                        source === 'rental_order' ? 'Rental Base' :
                        source === 'booking_deposit' ? 'Booking Deposit' :
                        source === 'late_fee' ? 'Late Return Fees' :
                        source === 'damage_fee' ? 'Damage & Loss Fees' :
                        source === 'invoice_payment' ? 'Invoice Outflows' :
                        'Miscellaneous / Manual';
                      
                      return (
                        <div key={source} className="space-y-1 text-xs">
                          <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                            <span className="font-bold">{label}</span>
                            <span className="font-mono">{activeCompany.currency || 'UGX'} {amount.toLocaleString()} ({percent}%)</span>
                          </div>
                          <div className="w-full bg-slate-200/10 dark:bg-slate-800/10 h-2 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${
                                source === 'rental_order' ? 'bg-blue-500' :
                                source === 'booking_deposit' ? 'bg-amber-500' :
                                source === 'late_fee' ? 'bg-red-500' :
                                source === 'damage_fee' ? 'bg-orange-500' :
                                source === 'invoice_payment' ? 'bg-indigo-500' :
                                'bg-slate-500'
                              }`} 
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {Object.keys(incomeAnalytics?.bySource || {}).length === 0 && (
                      <p className="text-slate-400 text-center text-xs py-6">No income records registered yet.</p>
                    )}
                  </div>
                </div>

                {/* Method Breakdown */}
                <div className="bg-neo shadow-neo-outset p-5 rounded-2xl space-y-4">
                  <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-wider">Revenue by Payment Method</h4>
                  <div className="space-y-3">
                    {Object.entries(incomeAnalytics?.byMethod || {}).map(([method, amt]) => {
                      const amount = Number(amt);
                      const total = incomeAnalytics?.allTimeTotal || 1;
                      const percent = Math.round((amount / total) * 100);
                      const label = 
                        method === 'credit_card' ? 'Credit Card' :
                        method === 'bank_transfer' ? 'Bank Wire Transfer' :
                        method === 'mobile_money' ? 'Mobile Money (Mtn/Airtel)' :
                        method === 'stripe' ? 'Stripe Gateway' :
                        method.toUpperCase();

                      return (
                        <div key={method} className="space-y-1 text-xs">
                          <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                            <span className="font-bold">{label}</span>
                            <span className="font-mono">{activeCompany.currency || 'UGX'} {amount.toLocaleString()} ({percent}%)</span>
                          </div>
                          <div className="w-full bg-slate-200/10 dark:bg-slate-800/10 h-2 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${
                                method === 'cash' ? 'bg-green-500' :
                                method === 'check' ? 'bg-yellow-500' :
                                method === 'credit_card' ? 'bg-purple-500' :
                                method === 'bank_transfer' ? 'bg-blue-600' :
                                method === 'stripe' ? 'bg-indigo-600' :
                                method === 'mobile_money' ? 'bg-rose-500' :
                                'bg-slate-400'
                              }`} 
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {Object.keys(incomeAnalytics?.byMethod || {}).length === 0 && (
                      <p className="text-slate-400 text-center text-xs py-6">No income records registered yet.</p>
                    )}
                  </div>
                </div>

              </div>

              {/* Filter and Action Toolbar */}
              <div className="bg-neo shadow-neo-outset p-4 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
                
                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-3 text-slate-400" size={14} />
                    <input
                      type="text"
                      placeholder="Search desc/ref…"
                      value={revenueSearch}
                      onChange={e => setRevenueSearch(e.target.value)}
                      className="pl-9 pr-4 py-2 w-36 bg-neo shadow-neo-inset-sm border-none rounded-xl text-xs focus:outline-none text-slate-700 dark:text-slate-200"
                    />
                  </div>

                  <input
                    type="text"
                    placeholder="Customer Name…"
                    value={revenueCustomerFilter}
                    onChange={e => setRevenueCustomerFilter(e.target.value)}
                    className="px-3 py-2 w-36 bg-neo shadow-neo-inset-sm border-none rounded-xl text-xs focus:outline-none text-slate-700 dark:text-slate-200"
                  />

                  <select
                    value={revenueCategoryFilter}
                    onChange={e => setRevenueCategoryFilter(e.target.value)}
                    className="p-2 bg-neo shadow-neo-inset-sm border-none rounded-xl text-xs text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
                  >
                    <option value="">All Categories</option>
                    <option value="chairs">Chairs</option>
                    <option value="tents">Tents</option>
                    <option value="sound">Sound</option>
                    <option value="power">Power</option>
                    <option value="tables">Tables</option>
                    <option value="consumables">Consumables</option>
                  </select>

                  <select
                    value={revenueSourceFilter}
                    onChange={e => setRevenueSourceFilter(e.target.value)}
                    className="p-2 bg-neo shadow-neo-inset-sm border-none rounded-xl text-xs text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
                  >
                    <option value="">All Streams</option>
                    <option value="rental_order">Rental Base</option>
                    <option value="booking_deposit">Booking Deposit</option>
                    <option value="late_fee">Late Return Fees</option>
                    <option value="damage_fee">Damage Fees</option>
                    <option value="invoice_payment">Invoices</option>
                    <option value="manual">Manual entries</option>
                  </select>

                  <select
                    value={revenueMethodFilter}
                    onChange={e => setRevenueMethodFilter(e.target.value)}
                    className="p-2 bg-neo shadow-neo-inset-sm border-none rounded-xl text-xs text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
                  >
                    <option value="">All Methods</option>
                    <option value="cash">Cash</option>
                    <option value="check">Check</option>
                    <option value="credit_card">Credit Card</option>
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="stripe">Stripe Gateway</option>
                    <option value="mobile_money">Mobile Money</option>
                    <option value="other">Other</option>
                  </select>

                  <div className="flex items-center space-x-1.5 text-xs text-slate-500">
                    <input
                      type="date"
                      value={revenueStartDate}
                      onChange={e => setRevenueStartDate(e.target.value)}
                      className="p-1.5 bg-neo shadow-neo-inset-sm border-none rounded-xl text-[10px] focus:outline-none cursor-pointer"
                    />
                    <span>to</span>
                    <input
                      type="date"
                      value={revenueEndDate}
                      onChange={e => setRevenueEndDate(e.target.value)}
                      className="p-1.5 bg-neo shadow-neo-inset-sm border-none rounded-xl text-[10px] focus:outline-none cursor-pointer"
                    />
                  </div>

                  {(revenueSearch || revenueSourceFilter || revenueMethodFilter || revenueStartDate || revenueEndDate || revenueCategoryFilter || revenueCustomerFilter) && (
                    <button
                      onClick={() => {
                        setRevenueSearch('');
                        setRevenueSourceFilter('');
                        setRevenueMethodFilter('');
                        setRevenueStartDate('');
                        setRevenueEndDate('');
                        setRevenueCategoryFilter('');
                        setRevenueCustomerFilter('');
                      }}
                      className="text-[10px] font-bold text-red-500 hover:text-red-600 active-shrink transition-all px-2.5 py-1.5 rounded-xl bg-red-500/10 border border-red-500/25"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={handleExportRevenue}
                    className="px-3 py-2.5 bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs rounded-xl active-shrink transition-all cursor-pointer"
                    title="Export the filtered revenue ledger to CSV"
                  >
                    Export CSV
                  </button>
                  <button
                    onClick={() => setShowManualIncomeModal(true)}
                    className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-md active-shrink transition-all cursor-pointer"
                  >
                    ➕ Record Miscellaneous Income
                  </button>
                </div>
              </div>

              {/* Income Records Ledger Log */}
              <div className="bg-neo shadow-neo-outset rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                        <th className="p-4">Payment Date</th>
                        <th className="p-4">Description</th>
                        <th className="p-4">Inflow Stream</th>
                        <th className="p-4">Payment Method</th>
                        <th className="p-4">Reference</th>
                        <th className="p-4 text-right">Inflow Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200/10 text-slate-600 dark:text-slate-300">
                      {incomeRecords.map(rec => (
                        <tr key={rec.id} className="hover:bg-slate-200/5">
                          <td className="p-4 font-mono">{new Date(rec.paymentDate).toLocaleDateString()}</td>
                          <td className="p-4 font-medium text-slate-700 dark:text-slate-200">{rec.description}</td>
                          <td className="p-4">
                            <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                              rec.incomeSource === 'booking_deposit' ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20' :
                              rec.incomeSource === 'late_fee' ? 'bg-red-500/10 text-red-500 border border-red-500/20' :
                              rec.incomeSource === 'damage_fee' ? 'bg-orange-500/10 text-orange-500 border border-orange-500/20' :
                              rec.incomeSource === 'invoice_payment' ? 'bg-indigo-500/10 text-indigo-500 border border-indigo-500/20' :
                              rec.incomeSource === 'manual' ? 'bg-slate-500/10 text-slate-500 border border-slate-500/20' :
                              'bg-blue-500/10 text-blue-600 border border-blue-500/20'
                            }`}>
                              {rec.incomeSource.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="p-4 capitalize font-semibold">{rec.paymentMethod.replace('_', ' ')}</td>
                          <td className="p-4 font-mono font-semibold">{rec.referenceNumber || 'N/A'}</td>
                          <td className="p-4 text-right font-mono font-bold text-green-600 dark:text-green-400">
                            {rec.currency} {Number(rec.amount).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                      {incomeRecords.length === 0 && (
                        <tr>
                          <td colSpan={6} className="p-10 text-center text-slate-400 font-medium">
                            No cash inflows registered for the selected filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          )}

          {/* TAB: PURCHASES & LEDGER */}
          {activeTab === 'bookkeeping' && (
            <div className="space-y-6">
              
              {/* Sub Navigation Bar */}
              <div className="bg-neo shadow-neo-outset p-4 rounded-2xl flex items-center justify-between">
                <div className="flex space-x-3">
                  {([
                    { id: 'suppliers', label: 'Suppliers Directory' },
                    { id: 'pos', label: 'Purchase Orders' },
                    { id: 'expenses', label: 'Operating Expenses' },
                    { id: 'payroll', label: 'Payroll Periods' }
                  ] as const).map(sub => (
                    <button
                      key={sub.id}
                      onClick={() => setBookkeepingSubTab(sub.id)}
                      className={`px-4 py-2 rounded-xl text-xs font-bold transition-all active-shrink ${
                        bookkeepingSubTab === sub.id
                          ? 'bg-blue-600 text-white shadow-lg'
                          : 'bg-neo shadow-neo-outset-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>

                {/* Toolbar Context Actions */}
                <div>
                  {bookkeepingSubTab === 'suppliers' && (
                    <button
                      onClick={() => setShowSupplierModal(true)}
                      className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>Add Supplier</span>
                    </button>
                  )}
                  {bookkeepingSubTab === 'pos' && (
                    <button
                      onClick={() => {
                        setNewPONumber(`PO-${Date.now().toString().slice(-6)}`);
                        setNewPODate(new Date().toISOString().split('T')[0]);
                        setShowPOModal(true);
                      }}
                      className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>Create PO</span>
                    </button>
                  )}
                  {bookkeepingSubTab === 'expenses' && (
                    <button
                      onClick={() => {
                        setNewExpDate(new Date().toISOString().split('T')[0]);
                        setShowExpenseModal(true);
                      }}
                      className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>Log Expense</span>
                    </button>
                  )}
                  {bookkeepingSubTab === 'payroll' && (
                    <button
                      onClick={() => {
                        setNewPayrollStart(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
                        setNewPayrollEnd(new Date().toISOString().split('T')[0]);
                        setShowPayrollPeriodModal(true);
                      }}
                      className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>Run Payroll</span>
                    </button>
                  )}
                </div>
              </div>

              {/* SUB TAB 1: SUPPLIERS */}
              {bookkeepingSubTab === 'suppliers' && (
                <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200/10 text-[10px] font-bold uppercase text-slate-500">
                        <th className="px-4 py-3">Supplier Name</th>
                        <th className="px-4 py-3">Contact Person</th>
                        <th className="px-4 py-3">Phone & Email</th>
                        <th className="px-4 py-3">Address</th>
                        <th className="px-4 py-3">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs divide-y divide-slate-200/10">
                      {suppliers.map(sup => (
                        <tr key={sup.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                          <td className="px-4 py-3 font-bold text-slate-800 dark:text-slate-200">{sup.name}</td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{sup.contactPerson || '—'}</td>
                          <td className="px-4 py-3 text-slate-500">
                            <p>{sup.phone || '—'}</p>
                            <span className="text-[10px] block">{sup.email || ''}</span>
                          </td>
                          <td className="px-4 py-3 text-slate-500 truncate max-w-[200px]">{sup.address || '—'}</td>
                          <td className="px-4 py-3 text-slate-400 italic max-w-[200px] truncate">{sup.notes || '—'}</td>
                        </tr>
                      ))}
                      {suppliers.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-4 py-10 text-center text-slate-400">No suppliers registered.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* SUB TAB 2: PURCHASE ORDERS */}
              {bookkeepingSubTab === 'pos' && (
                <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200/10 text-[10px] font-bold uppercase text-slate-500">
                        <th className="px-4 py-3">PO Number</th>
                        <th className="px-4 py-3">Supplier</th>
                        <th className="px-4 py-3">Order Date</th>
                        <th className="px-4 py-3">Delivery Date</th>
                        <th className="px-4 py-3">PO Line Items</th>
                        <th className="px-4 py-3 text-right">Total Cost</th>
                        <th className="px-4 py-3 text-center">Status</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs divide-y divide-slate-200/10">
                      {purchaseOrders.map(po => (
                        <tr key={po.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                          <td className="px-4 py-3 font-mono font-bold text-slate-700 dark:text-slate-300">{po.poNumber}</td>
                          <td className="px-4 py-3 font-bold text-slate-800 dark:text-slate-200">{po.supplier?.name}</td>
                          <td className="px-4 py-3 font-mono">{po.orderDate}</td>
                          <td className="px-4 py-3 font-mono text-slate-500">{po.deliveryDate || '—'}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col space-y-1">
                              {(po.lineItems || []).map((li: any) => (
                                <span key={li.id} className="text-[10px] text-slate-600 dark:text-slate-400">
                                  {li.quantity}x {li.item?.name || li.description} (@ UGX {Number(li.unitCost).toLocaleString()})
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-slate-800 dark:text-slate-200">
                            UGX {Number(po.totalAmount).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-[10px] font-extrabold uppercase px-2.5 py-0.5 rounded-full ${
                              po.status === 'Received' ? 'text-green-600 bg-green-500/10 border border-green-500/20' :
                              po.status === 'Ordered' ? 'text-amber-500 bg-amber-500/10 border border-amber-500/20' :
                              po.status === 'Cancelled' ? 'text-red-500 bg-red-500/10 border border-red-500/20' :
                              'text-slate-500 bg-slate-500/10 border border-slate-500/20'
                            }`}>
                              {po.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right space-x-1.5">
                            {po.status === 'Ordered' && (
                              <>
                                <button
                                  onClick={() => handleUpdatePOStatus(po.id, 'Received')}
                                  className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-green-600 rounded-lg active-shrink transition-all cursor-pointer"
                                >
                                  Receive Items
                                </button>
                                <button
                                  onClick={() => handleUpdatePOStatus(po.id, 'Cancelled')}
                                  className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-red-500 rounded-lg active-shrink transition-all cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                      {purchaseOrders.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-4 py-10 text-center text-slate-400">No purchase orders created.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* SUB TAB 3: GENERAL EXPENSES */}
              {bookkeepingSubTab === 'expenses' && (
                <div className="space-y-6">
                  {/* Summary Metric Block */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl">
                      <p className="text-[10px] uppercase font-bold text-slate-400">Total Operating Expenses</p>
                      <h4 className="text-xl font-black text-slate-800 dark:text-white mt-1">
                        UGX {expenses.reduce((sum, exp) => sum + Number(exp.amount), 0).toLocaleString()}
                      </h4>
                    </div>
                  </div>

                  <div className="bg-neo shadow-neo-outset border border-slate-200/5 rounded-2xl overflow-hidden">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200/10 text-[10px] font-bold uppercase text-slate-500">
                          <th className="px-4 py-3">Expense Category</th>
                          <th className="px-4 py-3">Supplier Reference</th>
                          <th className="px-4 py-3">Expense Date</th>
                          <th className="px-4 py-3">Payment Method</th>
                          <th className="px-4 py-3">Notes</th>
                          <th className="px-4 py-3 text-right">Amount Paid</th>
                        </tr>
                      </thead>
                      <tbody className="text-xs divide-y divide-slate-200/10">
                        {expenses.map(exp => (
                          <tr key={exp.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                            <td className="px-4 py-3 font-bold text-slate-800 dark:text-slate-200">{exp.expenseCategory}</td>
                            <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{exp.supplier?.name || '— (Direct Out-of-pocket)'}</td>
                            <td className="px-4 py-3 font-mono">{exp.expenseDate}</td>
                            <td className="px-4 py-3">
                              <span className="text-[10px] font-bold bg-neo shadow-neo-inset-sm px-2 py-0.5 rounded-full text-slate-600 dark:text-slate-400">
                                {exp.paymentMethod}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-400 italic max-w-[200px] truncate">{exp.notes || '—'}</td>
                            <td className="px-4 py-3 text-right font-mono font-bold text-slate-800 dark:text-slate-200">
                              UGX {Number(exp.amount).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                        {expenses.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-4 py-10 text-center text-slate-400">No expenses logged.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* SUB TAB 4: PAYROLL CYCLES */}
              {bookkeepingSubTab === 'payroll' && (
                <div className="space-y-6">
                  {payrollPeriods.map(period => (
                    <div key={period.id} className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl space-y-4">
                      <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
                        <div>
                          <h4 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase">
                            Payroll Cycle: {period.startDate} to {period.endDate}
                          </h4>
                          <span className="text-[10px] text-slate-400">Created At: {period.createdAt?.split('T')[0] || ''}</span>
                        </div>
                        <div className="flex items-center space-x-3">
                          <span className={`text-[10px] font-extrabold uppercase px-2.5 py-0.5 rounded-full ${
                            period.status === 'Paid' ? 'text-green-600 bg-green-500/10 border border-green-500/20' :
                            'text-blue-600 bg-blue-500/10 border border-blue-500/20'
                          }`}>
                            {period.status}
                          </span>
                          {period.status === 'Open' && (
                            <button
                              onClick={() => handleUpdatePayrollPeriodStatus(period.id, 'Paid')}
                              className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] px-3 py-1 rounded-lg shadow active-shrink transition-all cursor-pointer"
                            >
                              Approve & Close Period
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Period Payments List */}
                      <div className="overflow-hidden">
                        <table className="w-full text-left">
                          <thead>
                            <tr className="text-[9px] font-bold uppercase text-slate-400">
                              <th className="pb-2">Employee</th>
                              <th className="pb-2">Shift Duties / Calculation Breakdown</th>
                              <th className="pb-2 text-right">Earning Payout</th>
                              <th className="pb-2 text-center">Status</th>
                              <th className="pb-2 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="text-xs divide-y divide-slate-200/10">
                            {(period.payments || []).map((pay: any) => (
                              <tr key={pay.id}>
                                <td className="py-2.5 font-bold text-slate-700 dark:text-slate-300">{pay.employee?.name}</td>
                                <td className="py-2.5 text-[10px] text-slate-500 max-w-sm truncate italic">{pay.notes || '—'}</td>
                                <td className="py-2.5 text-right font-mono font-bold text-slate-800 dark:text-slate-200">
                                  UGX {Number(pay.amount).toLocaleString()}
                                </td>
                                <td className="py-2.5 text-center">
                                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                                    pay.status === 'Paid' ? 'text-green-600 bg-green-500/10' : 'text-slate-500 bg-slate-500/10'
                                  }`}>
                                    {pay.status}
                                  </span>
                                </td>
                                <td className="py-2.5 text-right">
                                  {pay.status === 'Unpaid' && (
                                    <button
                                      onClick={() => {
                                        setPayEmployeePaymentId(pay.id);
                                        setPayEmployeeDate(new Date().toISOString().split('T')[0]);
                                        setShowPayEmployeeModal(true);
                                      }}
                                      className="px-2 py-0.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[9px] font-bold text-blue-600 rounded active-shrink transition-all cursor-pointer"
                                    >
                                      Record Pay
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                  {payrollPeriods.length === 0 && (
                    <div className="bg-neo shadow-neo-outset p-10 text-center text-slate-400 text-xs">No payroll periods generated.</div>
                  )}
                </div>
              )}

            </div>
          )}

          {/* TAB: HELP & SUPPORT CENTER */}
          {activeTab === 'help' && (
            <div className="space-y-8">

              {/* Hero Search Header */}
              <div className="relative bg-neo shadow-neo-outset rounded-3xl overflow-hidden p-8 text-center space-y-4">
                <div className="absolute inset-0 bg-gradient-to-br from-blue-600/10 via-indigo-600/5 to-purple-600/10 pointer-events-none" />
                <div className="relative z-10">
                  <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600/15 border border-blue-500/20 mx-auto mb-3">
                    <HelpCircle size={28} className="text-blue-500" />
                  </div>
                  <h2 className="text-xl font-black text-slate-800 dark:text-white">How can we help?</h2>
                  <p className="text-xs text-slate-500 mt-1">Search guides, documentation, and frequently asked questions</p>
                  <button
                    onClick={() => { setTutorialStep(0); setShowTutorial(true); }}
                    className="mt-3 inline-flex items-center space-x-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink transition-all cursor-pointer"
                  >
                    <span>▶</span><span>Take a Quick Tour</span>
                  </button>
                  <div className="relative max-w-md mx-auto mt-4">
                    <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search guides (e.g. 'late fees', 'statements')..."
                      value={helpSearch}
                      onChange={e => setHelpSearch(e.target.value)}
                      className="w-full bg-neo shadow-neo-inset-sm border-none pl-9 pr-4 py-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                    {helpSearch && (
                      <button
                        onClick={() => setHelpSearch('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Category Filter Cards */}
              <div>
                <h3 className="text-xs font-bold text-slate-500 uppercase mb-3">Browse by Category</h3>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* All Articles card */}
                  <button
                    onClick={() => { setSelectedHelpCategory(null); setHelpSearch(''); }}
                    className={`p-4 rounded-2xl text-left space-y-2 active-shrink transition-all ${
                      selectedHelpCategory === null
                        ? 'bg-blue-600 shadow-lg shadow-blue-500/25 text-white'
                        : 'bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${selectedHelpCategory === null ? 'bg-white/20' : 'bg-neo shadow-neo-outset-sm'}`}>
                      <Search size={16} className={selectedHelpCategory === null ? 'text-white' : 'text-blue-500'} />
                    </div>
                    <div>
                      <p className="text-xs font-black">All Guides</p>
                      <p className={`text-[10px] ${selectedHelpCategory === null ? 'text-blue-100' : 'text-slate-500'}`}>{helpArticles.length} articles</p>
                    </div>
                  </button>

                  {helpCategories.map(cat => {
                    const isActive = selectedHelpCategory === cat.id;
                    const catCount = cat._count?.articles || 0;
                    return (
                      <button
                        key={cat.id}
                        onClick={() => setSelectedHelpCategory(isActive ? null : cat.id)}
                        className={`p-4 rounded-2xl text-left space-y-2 active-shrink transition-all ${
                          isActive
                            ? 'bg-blue-600 shadow-lg shadow-blue-500/25 text-white'
                            : 'bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${isActive ? 'bg-white/20' : 'bg-neo shadow-neo-outset-sm'}`}>
                          {cat.icon === 'FileText' && <FileText size={16} className={isActive ? 'text-white' : 'text-blue-500'} />}
                          {cat.icon === 'Truck' && <Truck size={16} className={isActive ? 'text-white' : 'text-emerald-500'} />}
                          {cat.icon === 'CalendarRange' && <CalendarRange size={16} className={isActive ? 'text-white' : 'text-purple-500'} />}
                          {cat.icon === 'Building' && <Building size={16} className={isActive ? 'text-white' : 'text-amber-500'} />}
                          {!['FileText','Truck','CalendarRange','Building'].includes(cat.icon) && <HelpCircle size={16} className={isActive ? 'text-white' : 'text-slate-500'} />}
                        </div>
                        <div>
                          <p className="text-xs font-black">{cat.name}</p>
                          <p className={`text-[10px] ${isActive ? 'text-blue-100' : 'text-slate-500'}`}>{catCount} {catCount === 1 ? 'article' : 'articles'}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Articles Guide List */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-bold text-slate-500 uppercase">
                    {helpSearch ? `Search results for "${helpSearch}"` : selectedHelpCategory ? `${helpCategories.find(c => c.id === selectedHelpCategory)?.name || ''} Guides` : 'All Guides'}
                  </h3>
                  <span className="text-[10px] text-slate-400 font-bold">{helpArticles.length} article{helpArticles.length !== 1 ? 's' : ''}</span>
                </div>

                {helpArticles.length === 0 ? (
                  <div className="bg-neo shadow-neo-outset rounded-2xl p-8 text-center space-y-2">
                    <AlertCircle size={28} className="text-slate-400 mx-auto" />
                    <p className="text-sm font-bold text-slate-500">No guides found</p>
                    <p className="text-xs text-slate-400">Try adjusting your search or selecting a different category</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {helpArticles.map(article => {
                      const cat = helpCategories.find(c => c.id === article.categoryId);
                      return (
                        <button
                          key={article.id}
                          onClick={() => handleViewArticle(article.id)}
                          className="bg-neo shadow-neo-outset hover:shadow-neo-inset-sm p-5 rounded-2xl text-left space-y-3 active-shrink transition-all group"
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="text-xs font-black text-slate-800 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{article.title}</p>
                              <p className="text-[10px] text-slate-500 mt-1">{cat?.name || 'General'}</p>
                            </div>
                            <div className="ml-3 w-7 h-7 rounded-lg bg-neo shadow-neo-outset-sm flex items-center justify-center shrink-0">
                              <FileText size={12} className="text-blue-500" />
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <span className="text-[9px] font-bold text-slate-400 uppercase">
                              Updated {new Date(article.updatedAt).toLocaleDateString()}
                            </span>
                            <span className="text-[9px] text-blue-500 font-bold group-hover:underline">Read Guide →</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* FAQ Accordion */}
              <div>
                <h3 className="text-xs font-bold text-slate-500 uppercase mb-3">Frequently Asked Questions</h3>
                <div className="space-y-3">
                  {helpFaqs.map(faq => {
                    const isExpanded = expandedFaqId === faq.id;
                    return (
                      <div
                        key={faq.id}
                        className={`bg-neo rounded-2xl overflow-hidden transition-all ${isExpanded ? 'shadow-neo-inset-sm' : 'shadow-neo-outset'}`}
                      >
                        <button
                          onClick={() => setExpandedFaqId(isExpanded ? null : faq.id)}
                          className="w-full flex items-center justify-between p-4 text-left active-shrink"
                        >
                          <span className="text-xs font-bold text-slate-800 dark:text-slate-200 pr-4">{faq.question}</span>
                          <div className={`w-6 h-6 rounded-lg bg-neo ${isExpanded ? 'shadow-neo-inset-sm' : 'shadow-neo-outset-sm'} flex items-center justify-center shrink-0 transition-all`}>
                            <ChevronDown size={12} className={`text-slate-500 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                          </div>
                        </button>
                        {isExpanded && (
                          <div className="px-4 pb-4">
                            <div className="border-t border-slate-200/10 pt-3">
                              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{faq.answer}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {helpFaqs.length === 0 && (
                    <div className="bg-neo shadow-neo-outset rounded-2xl p-6 text-center">
                      <p className="text-xs text-slate-400">No FAQs loaded yet.</p>
                    </div>
                  )}
                </div>
              </div>

              {/* ── CONTACT MIDWAY SUPPORT ─────────────────────────────────
                  Files a real ticket into the central Midway support desk and
                  keeps the conversation in-app. Hidden entirely when the server
                  has no support channel key configured. */}
              {supportConfigured && (
                <div className="space-y-4">
                  <div className="flex items-center space-x-2">
                    <LifeBuoy size={16} className="text-blue-500" />
                    <h3 className="text-xs font-bold text-slate-500 uppercase">Still stuck? Contact Support</h3>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                    {/* New request */}
                    <div className="bg-neo shadow-neo-outset rounded-2xl p-5 space-y-3">
                      <div>
                        <p className="text-xs font-black text-slate-800 dark:text-white">Send us the issue</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          You'll get a reference number instantly and an agent will follow up.
                          Your name, email and company are attached automatically.
                        </p>
                      </div>

                      {/* Self-service first — search the Midway knowledge base. */}
                      <div className="relative">
                        <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          placeholder="Search known fixes first..."
                          value={supportKbQuery}
                          onChange={e => setSupportKbQuery(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleSupportKbSearch(); }}
                          onBlur={handleSupportKbSearch}
                          className="w-full bg-neo shadow-neo-inset-sm border-none pl-8 pr-3 py-2.5 rounded-xl text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none"
                        />
                      </div>
                      {supportKbResults !== null && (
                        <div className="space-y-1.5">
                          {supportKbResults.length === 0 ? (
                            <p className="text-[10px] text-slate-400 px-1">No known fix found — send us the details below.</p>
                          ) : supportKbResults.map((a: any) => (
                            <div key={a.id} className="bg-neo shadow-neo-inset-sm rounded-xl p-3">
                              <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{a.title}</p>
                              {a.solution && <p className="text-[10px] text-slate-500 mt-1 whitespace-pre-wrap">{a.solution}</p>}
                            </div>
                          ))}
                        </div>
                      )}

                      <input
                        type="text"
                        placeholder="Subject"
                        value={supportSubject}
                        onChange={e => setSupportSubject(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none px-3 py-2.5 rounded-xl text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none"
                      />
                      <textarea
                        placeholder="Describe what happened — include order or invoice numbers if relevant."
                        value={supportDescription}
                        onChange={e => setSupportDescription(e.target.value)}
                        rows={4}
                        className="w-full bg-neo shadow-neo-inset-sm border-none px-3 py-2.5 rounded-xl text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none resize-none"
                      />
                      <div className="flex items-center space-x-2">
                        <select
                          value={supportPriority}
                          onChange={e => setSupportPriority(e.target.value)}
                          className="bg-neo shadow-neo-inset-sm border-none px-3 py-2.5 rounded-xl text-[11px] text-slate-700 dark:text-slate-300 focus:outline-none cursor-pointer"
                        >
                          <option value="LOW">Low</option>
                          <option value="NORMAL">Normal</option>
                          <option value="HIGH">High</option>
                          <option value="URGENT">Urgent</option>
                        </select>
                        <button
                          onClick={handleSubmitSupportTicket}
                          disabled={supportSubmitting}
                          className="flex-1 flex items-center justify-center space-x-1.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[11px] font-bold rounded-xl active-shrink transition-all cursor-pointer"
                        >
                          <Send size={12} />
                          <span>{supportSubmitting ? 'Sending...' : 'Send Request'}</span>
                        </button>
                      </div>

                      {supportNotice && (
                        <div className={`flex items-start space-x-2 rounded-xl p-3 ${supportNotice.kind === 'ok' ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                          {supportNotice.kind === 'ok'
                            ? <CheckCircle2 size={13} className="text-emerald-500 mt-0.5 shrink-0" />
                            : <AlertCircle size={13} className="text-red-500 mt-0.5 shrink-0" />}
                          <p className={`text-[10px] ${supportNotice.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                            {supportNotice.text}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* My requests + thread */}
                    <div className="bg-neo shadow-neo-outset rounded-2xl p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-black text-slate-800 dark:text-white">My requests</p>
                        <span className="text-[10px] text-slate-400 font-bold">
                          {supportTickets.length} request{supportTickets.length !== 1 ? 's' : ''}
                        </span>
                      </div>

                      {supportTickets.length === 0 ? (
                        <div className="text-center py-8">
                          <MessageSquare size={22} className="text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                          <p className="text-[10px] text-slate-400">No support requests yet.</p>
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                          {supportTickets.map((t: any) => {
                            const isOpen = supportOpenRef === t.ref;
                            const statusTone =
                              t.status === 'RESOLVED' || t.status === 'CLOSED' ? 'text-emerald-500'
                              : t.status === 'IN_PROGRESS' ? 'text-blue-500'
                              : t.status === 'WAITING' ? 'text-amber-500'
                              : 'text-slate-400';
                            return (
                              <div key={t.ref} className="bg-neo shadow-neo-inset-sm rounded-xl overflow-hidden">
                                <button
                                  onClick={() => openSupportThread(t.ref)}
                                  className="w-full text-left p-3 active-shrink transition-all cursor-pointer"
                                >
                                  <div className="flex items-start justify-between space-x-2">
                                    <div className="min-w-0">
                                      <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate">{t.subject}</p>
                                      <p className="text-[9px] text-slate-400 font-mono mt-0.5">{t.ref}</p>
                                    </div>
                                    <div className="text-right shrink-0">
                                      <p className={`text-[9px] font-black uppercase ${statusTone}`}>{String(t.status).replace('_', ' ')}</p>
                                      <p className="text-[9px] text-slate-400 mt-0.5">{t.priority}</p>
                                    </div>
                                  </div>
                                </button>

                                {isOpen && (
                                  <div className="border-t border-slate-200/40 dark:border-slate-700/40 p-3 space-y-2">
                                    {supportThreadLoading ? (
                                      <p className="text-[10px] text-slate-400 text-center py-3">Loading conversation...</p>
                                    ) : !supportThread ? (
                                      <p className="text-[10px] text-slate-400 text-center py-3">Could not load this conversation.</p>
                                    ) : (
                                      <>
                                        <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                                          {(supportThread.messages || []).map((m: any, i: number) => (
                                            <div
                                              key={i}
                                              className={`rounded-lg p-2.5 ${m.author === 'AGENT'
                                                ? 'bg-blue-500/10 border border-blue-500/20'
                                                : m.author === 'SYSTEM'
                                                  ? 'bg-slate-500/5 border border-slate-500/10'
                                                  : 'bg-neo shadow-neo-outset-sm'}`}
                                            >
                                              <div className="flex items-center justify-between mb-1">
                                                <p className="text-[9px] font-black uppercase text-slate-500">
                                                  {m.author === 'REQUESTER' ? 'You' : m.author === 'AGENT' ? `Agent · ${m.name}` : 'Midway Support'}
                                                </p>
                                                <p className="text-[9px] text-slate-400">
                                                  {m.at ? new Date(m.at).toLocaleString() : ''}
                                                </p>
                                              </div>
                                              <p className="text-[10px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{m.body}</p>
                                            </div>
                                          ))}
                                        </div>

                                        {supportThread.status === 'CLOSED' ? (
                                          <p className="text-[10px] text-slate-400 text-center py-2">
                                            This request is closed. Open a new one if you still need help.
                                          </p>
                                        ) : (
                                          <div className="flex items-center space-x-2">
                                            <input
                                              type="text"
                                              placeholder="Write a reply..."
                                              value={supportReply}
                                              onChange={e => setSupportReply(e.target.value)}
                                              onKeyDown={e => { if (e.key === 'Enter') handleSendSupportReply(); }}
                                              className="flex-1 bg-neo shadow-neo-inset-sm border-none px-3 py-2 rounded-lg text-[10px] text-slate-800 dark:text-slate-200 focus:outline-none"
                                            />
                                            <button
                                              onClick={handleSendSupportReply}
                                              disabled={!supportReply.trim()}
                                              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg active-shrink transition-all cursor-pointer"
                                            >
                                              <Send size={11} />
                                            </button>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* TAB: SYSTEM HEALTH / DIAGNOSTIC BOARD */}
          {activeTab === 'health' && (
            <div className="space-y-8">

              {/* Status Header Overview Card */}
              <div className="bg-neo shadow-neo-outset p-6 rounded-3xl flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="space-y-1">
                  <h3 className="text-sm font-black text-slate-800 dark:text-white">Overall System Status</h3>
                  <p className="text-xs text-slate-500">
                    {systemComponents.every(c => c.status === 'operational') ? (
                      <span className="text-green-600 dark:text-green-400 font-bold flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-ping" />
                        All components are fully operational.
                      </span>
                    ) : systemComponents.some(c => c.status === 'major_outage') ? (
                      <span className="text-red-600 dark:text-red-400 font-bold flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                        Critical Outage detected. Engineering team is responding.
                      </span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400 font-bold flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
                        Partial degradation or scheduled maintenance in progress.
                      </span>
                    )}
                  </p>
                </div>
                <div>
                  <button
                    onClick={() => {
                      if (systemComponents.length > 0) {
                        setIncidentComponentId(systemComponents[0].id.toString());
                      }
                      setIncidentTitle('');
                      setIncidentMessage('');
                      setIncidentSeverity('info');
                      setShowIncidentModal(true);
                    }}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer border-none"
                  >
                    <Plus size={14} />
                    <span>Report Incident</span>
                  </button>
                </div>
              </div>

              {/* Components Status Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {systemComponents.map(component => {
                  const statusColors: Record<string, string> = {
                    operational: 'text-green-600 bg-green-500/10 border-green-500/20',
                    degraded: 'text-amber-600 bg-amber-500/10 border-amber-500/20',
                    partial_outage: 'text-orange-600 bg-orange-500/10 border-orange-500/20',
                    major_outage: 'text-red-600 bg-red-500/10 border-red-500/20',
                    maintenance: 'text-blue-600 bg-blue-500/10 border-blue-500/20'
                  };
                  return (
                    <div key={component.id} className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl flex flex-col justify-between space-y-4">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <h4 className="text-xs font-black text-slate-800 dark:text-white">{component.name}</h4>
                          <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${statusColors[component.status] || 'text-slate-500'}`}>
                            {component.status.replace('_', ' ')}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{component.description}</p>
                      </div>

                      {/* Status Override Toggle */}
                      <div className="border-t border-slate-200/10 pt-3 flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-400 uppercase">Set Status</span>
                        <select
                          value={component.status}
                          onChange={(e) => handleToggleComponentStatus(component.id, e.target.value)}
                          className="text-[10px] font-bold p-1 px-2 rounded-lg bg-neo shadow-neo-outset border-none text-right focus:outline-none cursor-pointer text-slate-700 dark:text-slate-300"
                        >
                          <option value="operational">Operational</option>
                          <option value="degraded">Degraded</option>
                          <option value="partial_outage">Partial Outage</option>
                          <option value="major_outage">Major Outage</option>
                          <option value="maintenance">Maintenance</option>
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Incidents Log Board */}
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-3xl space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200/10 pb-4">
                  <div>
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Incidents Log & Diagnostics</h3>
                    <p className="text-[10px] text-slate-500 mt-0.5">Historical and active system disruptions</p>
                  </div>
                  <div>
                    <select
                      value={selectedSystemComponent || ''}
                      onChange={(e) => setSelectedSystemComponent(e.target.value ? parseInt(e.target.value) : null)}
                      className="bg-neo shadow-neo-outset-sm border-none p-2 rounded-xl text-[11px] font-bold text-slate-700 dark:text-slate-300 focus:outline-none cursor-pointer"
                    >
                      <option value="">All Components</option>
                      {systemComponents.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-4 max-h-[500px] overflow-y-auto pr-1">
                  {systemIncidents.length === 0 ? (
                    <div className="text-center py-8">
                      <CheckCircle2 className="text-green-500 mx-auto mb-2" size={24} />
                      <p className="text-xs font-bold text-slate-500">No incidents reported</p>
                      <p className="text-[10px] text-slate-400">All components running smoothly.</p>
                    </div>
                  ) : (
                    systemIncidents.map(incident => {
                      const sevColors: Record<string, string> = {
                        info: 'bg-blue-500/10 text-blue-600 border border-blue-500/20',
                        warning: 'bg-amber-500/10 text-amber-600 border border-amber-500/20',
                        critical: 'bg-red-500/10 text-red-600 border border-red-500/20',
                        resolved: 'bg-green-500/10 text-green-600 border border-green-500/20'
                      };
                      return (
                        <div key={incident.id} className="bg-neo shadow-neo-inset-sm p-4 rounded-xl space-y-3">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div className="flex items-center space-x-2.5">
                              <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${sevColors[incident.severity] || 'text-slate-500'}`}>
                                {incident.severity}
                              </span>
                              <h4 className="text-xs font-black text-slate-800 dark:text-slate-200">{incident.title}</h4>
                            </div>
                            <span className="text-[10px] text-slate-500 font-mono">
                              {new Date(incident.createdAt).toLocaleString()}
                            </span>
                          </div>

                          <div className="space-y-1">
                            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{incident.message}</p>
                            <div className="flex items-center justify-between text-[10px] text-slate-500 font-medium">
                              <span>Component: <strong className="text-slate-700 dark:text-slate-300">{incident.component?.name || 'N/A'}</strong></span>
                              <span>Reporter: <strong className="text-slate-700 dark:text-slate-300 font-mono">{incident.reporter}</strong></span>
                            </div>
                          </div>

                          {incident.severity !== 'resolved' && (
                            <div className="border-t border-slate-200/5 pt-2.5 flex justify-end">
                              <button
                                onClick={() => handleResolveIncident(incident.id)}
                                className="px-3 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset text-[9px] font-black text-green-600 rounded-lg active-shrink transition-all flex items-center space-x-1 border-none cursor-pointer"
                              >
                                <Check size={10} />
                                <span>Mark Resolved</span>
                              </button>
                            </div>
                          )}
                          {incident.severity === 'resolved' && incident.resolvedAt && (
                            <div className="border-t border-slate-200/5 pt-2 text-[10px] text-green-600 dark:text-green-400 font-semibold flex items-center space-x-1">
                              <Check size={12} />
                              <span>Resolved at {new Date(incident.resolvedAt).toLocaleString()}</span>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

            </div>
          )}

          {/* TAB 6: SETTINGS */}
          {/* TAB 6: SETTINGS */}
          {activeTab === 'settings' && (
            settingsSection === null ? (
              /* The index. Each card opens one section, so no panel has to share
                 the viewport with seven others. */
              <div className="space-y-8">
                {SETTINGS_GROUPS.map(group => (
                  <div key={group.group}>
                    <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">{group.group}</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {group.items.filter(item => item.key !== 'license' || !!licenseStatus?.enforced).map(item => {
                        const Icon = item.icon;
                        return (
                          <button
                            key={item.key}
                            onClick={() => setSettingsSection(item.key)}
                            className="group bg-neo shadow-neo-outset hover:shadow-neo-inset-sm border border-slate-200/5 rounded-2xl p-5 flex gap-4 items-start text-left active-shrink transition-all cursor-pointer"
                          >
                            <div className="w-10 h-10 shrink-0 bg-neo shadow-neo-inset-sm rounded-xl flex items-center justify-center">
                              <Icon size={17} className="text-slate-600 dark:text-slate-300" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-black text-slate-800 dark:text-white">{item.title}</p>
                              <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">{item.description}</p>
                            </div>
                            <ChevronRight size={14} className="ml-auto shrink-0 text-slate-300 dark:text-slate-600 group-hover:text-blue-500 transition-colors" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-5 max-w-5xl">
                <button
                  onClick={() => setSettingsSection(null)}
                  className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 active-shrink transition-colors cursor-pointer"
                >
                  <ArrowLeft size={13} /> All settings
                </button>

              {settingsSection === 'business' && (
                <div className="space-y-6">
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-2xl space-y-6">
                <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase border-b border-slate-200/10 pb-2">Business Settings</h3>
                
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Default Currency</label>
                    <select
                      value={bizSettings.currency}
                      onChange={e => setBizSettings(s => ({ ...s, currency: e.target.value }))}
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none">
                      <option value="UGX">Ugandan Shilling (UGX)</option>
                      <option value="USD">US Dollar (USD)</option>
                      <option value="KES">Kenyan Shilling (KES)</option>
                      <option value="NGN">Nigerian Naira (NGN)</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Default Payment Terms</label>
                    <select
                      value={bizSettings.defaultPaymentTermsDays}
                      onChange={e => setBizSettings(s => ({ ...s, defaultPaymentTermsDays: parseInt(e.target.value) }))}
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none">
                      <option value="30">Net 30 Days</option>
                      <option value="15">Net 15 Days</option>
                      <option value="0">Due on Receipt</option>
                    </select>
                  </div>

                  {/* Return / reconciliation fee policy */}
                  <div className="border-t border-slate-200/10 pt-4">
                    <p className="text-[10px] uppercase font-black text-slate-500 mb-3">Return &amp; Reconciliation Fee Policy</p>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500 block">Late Fee /day (%)</label>
                        <input type="number" min={0} value={bizSettings.lateFeePercentPerDay}
                          onChange={e => setBizSettings(s => ({ ...s, lateFeePercentPerDay: Number(e.target.value) }))}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-center text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500 block">Damage Fee (%)</label>
                        <input type="number" min={0} value={bizSettings.damageFeePercent}
                          onChange={e => setBizSettings(s => ({ ...s, damageFeePercent: Number(e.target.value) }))}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-center text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500 block">Lost Fee (%)</label>
                        <input type="number" min={0} value={bizSettings.lostFeePercent}
                          onChange={e => setBizSettings(s => ({ ...s, lostFeePercent: Number(e.target.value) }))}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-center text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
                      </div>
                    </div>
                    <p className="text-[9px] text-slate-400 mt-2 leading-relaxed">
                      Damage/Lost fees are a percentage of each item's <strong>replacement cost</strong> (e.g. a damaged item at 50% is charged half its replacement value). Late fee compounds per overdue day against the daily rate.
                    </p>

                    <label className="flex items-center justify-between mt-3 cursor-pointer">
                      <span className="text-[10px] uppercase font-bold text-slate-500">Restock returned assets to Available</span>
                      <input type="checkbox" checked={bizSettings.restockReturnedItems}
                        onChange={e => setBizSettings(s => ({ ...s, restockReturnedItems: e.target.checked }))}
                        className="w-4 h-4 accent-blue-600 cursor-pointer" />
                    </label>
                  </div>

                  <button
                    onClick={handleSaveBizSettings}
                    disabled={savingBizSettings}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink transition-all cursor-pointer disabled:opacity-60">
                    {savingBizSettings ? 'Saving…' : 'Save Business Settings'}
                  </button>

                  <div className="border-t border-slate-200/10 pt-4 space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] uppercase font-bold text-slate-500">Subscription Status</span>
                      <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[10px] font-black uppercase">
                        {currentUser?.company?.plan?.name || "Enterprise Plan"}
                      </span>
                    </div>

                    <div className="bg-neo shadow-neo-inset-sm p-3.5 rounded-xl space-y-2 text-xs border border-transparent">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">Asset Catalog Items:</span>
                        <span className="font-bold text-slate-800 dark:text-slate-200">
                          {items.length} / {currentUser?.company?.plan?.maxItems || "5,000"}
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                        <div 
                          className="bg-blue-600 h-full rounded-full transition-all duration-500" 
                          style={{ width: `${Math.min(100, (items.length / (currentUser?.company?.plan?.maxItems || 5000)) * 100)}%` }}
                        />
                      </div>

                      <div className="flex justify-between text-[11px] mt-1">
                        <span className="text-slate-500">Users Registered:</span>
                        <span className="font-bold text-slate-800 dark:text-slate-200">
                          {companies.length > 0 ? 1 : 1} / {currentUser?.company?.plan?.maxUsers || "50"}
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                        <div 
                          className="bg-emerald-500 h-full rounded-full transition-all duration-500" 
                          style={{ width: `${Math.min(100, (1 / (currentUser?.company?.plan?.maxUsers || 50)) * 100)}%` }}
                        />
                      </div>
                    </div>

                    <button
                      onClick={() => setShowBillingModal(true)}
                      className="w-full py-2.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-blue-600 dark:text-blue-400 rounded-xl active-shrink transition-all cursor-pointer border border-[#cbd5e1]/10 dark:border-slate-800/10"
                    >
                      Manage Billing & Upgrade
                    </button>
                  </div>
                </div>
              </div>

                </div>
              )}

              {settingsSection === 'notifications' && (
                <div className="space-y-6">
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-2xl space-y-4">
                <div>
                  <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase border-b border-slate-200/10 pb-2">Notifications &amp; Audit Log</h3>
                  <p className="text-[10px] text-slate-500 mt-1">Choose which alerts appear in your bell, and review the system audit trail.</p>
                </div>

                {/* Per-user notification preferences */}
                <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-2 border border-transparent">
                  <p className="text-[10px] uppercase font-black text-slate-500">My Alert Preferences</p>
                  {([
                    ['overdue', 'Overdue rentals'],
                    ['lowStock', 'Low stock warnings'],
                    ['returns', 'Returns processed'],
                    ['payments', 'Payments received'],
                    ['bookings', 'New bookings'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center justify-between cursor-pointer">
                      <span className="text-[11px] text-slate-600 dark:text-slate-400">{label}</span>
                      <input
                        type="checkbox"
                        checked={notifPrefs[key] !== false}
                        onChange={e => saveNotifPref(key, e.target.checked)}
                        className="w-4 h-4 accent-blue-600 cursor-pointer"
                      />
                    </label>
                  ))}
                </div>

                <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                  {auditLogs.length === 0 ? (
                    <div className="text-center py-8 text-slate-400 text-xs">
                      No logs recorded yet. Create a booking or record a payment to trigger alerts.
                    </div>
                  ) : (
                    auditLogs.map((log) => (
                      <div key={log.id} className="bg-neo shadow-neo-inset-sm rounded-xl p-3 border border-transparent space-y-1.5 text-left text-xs">
                        <div className="flex justify-between items-center text-[10px]">
                          <span className="font-bold text-blue-600 dark:text-blue-400 uppercase">{log.action}</span>
                          <span className="text-slate-400">{new Date(log.createdAt).toLocaleString()}</span>
                        </div>
                        <p className="text-slate-700 dark:text-slate-300 font-semibold text-[11px]">
                          Target: {log.modelName} ({log.objectRepr})
                        </p>
                        <p className="text-[10px] text-slate-500 leading-relaxed font-mono bg-slate-200/10 p-1.5 rounded dark:bg-slate-800/10 select-all">
                          {log.additionalInfo}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>

                </div>
              )}

              {settingsSection === 'tax' && (
                <div className="space-y-6">
              {/* TAX RATES */}
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-2xl">
                <TaxRatesPanel
                  apiUrl={API_URL}
                  companyId={selectedCompanyId}
                  pricesIncludeTax={bizSettings.pricesIncludeTax}
                  onPricesIncludeTaxChange={async (value) => {
                    // Saved immediately rather than waiting for the Save button:
                    // it lives in the tax card, and the two would look unrelated.
                    setBizSettings(b => ({ ...b, pricesIncludeTax: value }));
                    try {
                      await fetch(`${API_URL}/api/companies/${selectedCompanyId}/settings`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json', 'x-company-id': String(selectedCompanyId) },
                        body: JSON.stringify({ pricesIncludeTax: value }),
                      });
                      await fetchAllData();
                    } catch { /* the toggle reverts on the next company load */ }
                  }}
                  onChanged={fetchAllData}
                />
              </div>

                </div>
              )}

              {settingsSection === 'efris' && (
                <div className="space-y-6">
              {/* URA EFRIS */}
              <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-2xl">
                <EfrisPanel
                  apiUrl={API_URL}
                  companyId={selectedCompanyId}
                  onSaved={async () => { await refreshEfrisConfig(); await fetchAllData(); }}
                />
              </div>

                </div>
              )}

              {settingsSection === 'team' && (
                <div className="space-y-6">
              {/* TEAM & ACCESS */}
              <div className="lg:col-span-2 bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-2xl space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200/10 pb-2">
                  <div>
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Team &amp; Access</h3>
                    <p className="text-[10px] text-slate-500 mt-0.5">Manage who can sign in and their access level. Admins see financials &amp; settings; Staff have restricted access.</p>
                  </div>
                  <button
                    onClick={() => setShowAddUserModal(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                  >
                    <Plus size={14} />
                    <span>Add Team Member</span>
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                        <th className="p-2.5">Name</th>
                        <th className="p-2.5">Username</th>
                        <th className="p-2.5">Email</th>
                        <th className="p-2.5 text-center">Role</th>
                        <th className="p-2.5 text-center">Status</th>
                        <th className="p-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200/10">
                      {companyUsers.map(u => (
                        <tr key={u.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                          <td className="p-2.5 font-bold text-slate-800 dark:text-slate-200">
                            {(u.firstName || '') + ' ' + (u.lastName || '')}
                            {u.id === currentUser?.user?.id && <span className="ml-1.5 text-[9px] text-blue-500 font-black">(you)</span>}
                          </td>
                          <td className="p-2.5 font-mono text-slate-500">{u.username}</td>
                          <td className="p-2.5 text-slate-500">{u.email}</td>
                          <td className="p-2.5 text-center">
                            <select
                              value={u.companyRoleId ?? ''}
                              onChange={(e) => handleUpdateUser(u.id, { companyRoleId: parseInt(e.target.value) })}
                              className="bg-neo shadow-neo-inset-sm border-none px-2 py-1 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none font-bold cursor-pointer"
                            >
                              {!companyRoles.some(r => r.id === u.companyRoleId) && <option value="">{u.roleName || '—'}</option>}
                              {companyRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </select>
                          </td>
                          <td className="p-2.5 text-center">
                            <button
                              onClick={() => handleUpdateUser(u.id, { isActive: !u.isActive })}
                              className={`text-[10px] font-extrabold uppercase px-2.5 py-0.5 rounded-full cursor-pointer ${u.isActive ? 'text-green-600 bg-green-500/10 border border-green-500/20' : 'text-slate-500 bg-slate-400/10 border border-slate-400/20'}`}
                            >
                              {u.isActive ? 'Active' : 'Disabled'}
                            </button>
                          </td>
                          <td className="p-2.5 text-right">
                            {u.id !== currentUser?.user?.id && (
                              <button
                                onClick={() => handleRemoveUser(u.id, u.username)}
                                className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-red-500 rounded-lg active-shrink transition-all cursor-pointer"
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {companyUsers.length === 0 && (
                        <tr><td colSpan={6} className="p-4 text-center text-slate-400 text-xs">No team members loaded.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

                </div>
              )}

              {settingsSection === 'roles' && (
                <div className="space-y-6">
              {/* ROLES & PERMISSIONS */}
              <div className="lg:col-span-2 bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-2xl space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200/10 pb-2">
                  <div className="flex items-center gap-2">
                    <ShieldAlert size={16} className="text-blue-600 dark:text-blue-400" />
                    <div>
                      <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Roles &amp; Permissions</h3>
                      <p className="text-[10px] text-slate-500 mt-0.5">Define what each role can see and do. Assign roles to team members above.</p>
                    </div>
                  </div>
                  <button
                    onClick={() => openRoleEditor(null)}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2 rounded-xl shadow-lg flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                  >
                    <Plus size={14} />
                    <span>New Role</span>
                  </button>
                </div>

                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {companyRoles.map(r => {
                    const granted = Object.values(r.permissions || {}).reduce((n, row) => n + Object.values(row || {}).filter(Boolean).length, 0);
                    return (
                      <div key={r.id} className="bg-neo shadow-neo-inset-sm rounded-xl p-3 border border-transparent space-y-2">
                        <div className="flex items-start justify-between">
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate flex items-center gap-1.5">
                              {r.name}
                              {r.isSystemAdmin && <span className="text-[8px] font-black uppercase bg-blue-500/10 text-blue-600 px-1 rounded">built-in</span>}
                            </p>
                            <p className="text-[10px] text-slate-500 truncate">{r.description || (r.isSystemAdmin ? 'Full access to everything.' : 'Custom role')}</p>
                          </div>
                        </div>
                        <p className="text-[10px] text-slate-500">
                          {r.isSystemAdmin ? 'All permissions' : `${granted} permission${granted === 1 ? '' : 's'}`} · {r.memberCount} member{r.memberCount === 1 ? '' : 's'}
                        </p>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => openRoleEditor(r)}
                            disabled={r.isSystemAdmin}
                            className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {r.isSystemAdmin ? 'View only' : 'Edit'}
                          </button>
                          {!r.isSystemAdmin && (
                            <button
                              onClick={() => handleDeleteRole(r)}
                              className="px-2.5 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-red-500 rounded-lg active-shrink transition-all cursor-pointer"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {companyRoles.length === 0 && (
                    <div className="col-span-full text-center py-6 text-slate-400 text-xs">No roles loaded.</div>
                  )}
                </div>
              </div>

                </div>
              )}

              {settingsSection === 'backup' && (
                <div className="space-y-6">
              {/* DATABASE BACKUP & RESTORE */}
              <div className="lg:col-span-2 bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-2xl space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200/10 pb-2">
                  <div className="flex items-center gap-2">
                    <Database size={16} className="text-blue-600 dark:text-blue-400" />
                    <div>
                      <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Database Backup &amp; Restore</h3>
                      <p className="text-[10px] text-slate-500 mt-0.5">Automatic daily backups protect your data. Each backup is a separate timestamped file — new backups never overwrite old ones.</p>
                    </div>
                  </div>
                  <button
                    onClick={handleRunBackup}
                    disabled={backupBusy}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs px-4 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                  >
                    <Save size={14} />
                    <span>{backupBusy ? 'Working…' : 'Backup Now'}</span>
                  </button>
                </div>

                {backupInfo && (
                  <>
                    {/* Auto-backup settings */}
                    <div className="grid sm:grid-cols-3 gap-3">
                      <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-2 border border-transparent">
                        <label className="flex items-center justify-between cursor-pointer">
                          <span className="text-[10px] uppercase font-black text-slate-500">Automatic Backup</span>
                          <input
                            type="checkbox"
                            checked={backupInfo.config.enabled}
                            onChange={e => handleSaveBackupConfig({ enabled: e.target.checked })}
                            className="w-4 h-4 accent-blue-600 cursor-pointer"
                          />
                        </label>
                        <p className="text-[10px] text-slate-500 leading-relaxed">Runs daily. If the app was closed at the scheduled time, it catches up next time you open it.</p>
                      </div>
                      <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-1 border border-transparent">
                        <label className="text-[10px] uppercase font-black text-slate-500 flex items-center gap-1"><Clock size={11} /> Daily Time</label>
                        <select
                          value={backupInfo.config.hour}
                          onChange={e => handleSaveBackupConfig({ hour: parseInt(e.target.value) })}
                          disabled={!backupInfo.config.enabled}
                          className="w-full bg-neo shadow-neo-inset-sm border-none px-2 py-1.5 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none font-bold cursor-pointer disabled:opacity-40"
                        >
                          {Array.from({ length: 24 }, (_, h) => (
                            <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                          ))}
                        </select>
                      </div>
                      <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-1 border border-transparent">
                        <label className="text-[10px] uppercase font-black text-slate-500">Keep Last</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            value={backupInfo.config.retention}
                            onChange={e => handleSaveBackupConfig({ retention: Math.max(1, parseInt(e.target.value) || 1) })}
                            className="w-16 bg-neo shadow-neo-inset-sm border-none px-2 py-1.5 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none font-bold"
                          />
                          <span className="text-[11px] text-slate-500">backups</span>
                        </div>
                        <p className="text-[10px] text-slate-500 leading-relaxed">Older backups beyond this are auto-removed. The most recent is always kept.</p>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-500 flex items-center gap-1.5">
                      <span className="font-black uppercase">Folder:</span>
                      <span className="font-mono select-all break-all">{backupInfo.config.dir}</span>
                    </p>

                    {/* Existing backups */}
                    <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                      {backupInfo.backups.length === 0 ? (
                        <div className="text-center py-6 text-slate-400 text-xs">No backups yet. Click “Backup Now” to create the first one.</div>
                      ) : (
                        backupInfo.backups.map(b => (
                          <div key={b.name} className="bg-neo shadow-neo-inset-sm rounded-xl p-3 border border-transparent flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-300 truncate">{b.name}</p>
                              <p className="text-[10px] text-slate-500">
                                {new Date(b.createdAt).toLocaleString()} · {(b.size / 1024).toFixed(0)} KB
                                <span className={`ml-2 uppercase font-black ${b.kind === 'auto' ? 'text-green-600 dark:text-green-400' : b.kind === 'prerestore' ? 'text-amber-500' : 'text-blue-500'}`}>{b.kind}</span>
                              </p>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button onClick={() => handleDownloadBackup(b.name)} title="Download" className="p-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-lg text-slate-500 hover:text-blue-500 active-shrink transition-all cursor-pointer"><Download size={13} /></button>
                              <button onClick={() => handleRestoreBackup(b.name)} disabled={backupBusy} title="Restore (overwrites current data)" className="p-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-lg text-slate-500 hover:text-amber-500 active-shrink transition-all cursor-pointer disabled:opacity-40"><RotateCcw size={13} /></button>
                              <button onClick={() => handleDeleteBackup(b.name)} title="Delete" className="p-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-lg text-slate-500 hover:text-red-500 active-shrink transition-all cursor-pointer"><Trash2 size={13} /></button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>

                </div>
              )}

              {settingsSection === 'license' && (
                <div className="space-y-6">
              {/* DESKTOP LICENSE (only shown when the server enforces licensing) */}
              {licenseStatus?.enforced && (
                <div className="lg:col-span-2 bg-neo shadow-neo-outset border border-slate-200/5 p-6 rounded-2xl space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-200/10 pb-2">
                    <div className="flex items-center gap-2">
                      <ShieldAlert size={16} className="text-blue-600 dark:text-blue-400" />
                      <div>
                        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Desktop License</h3>
                        <p className="text-[10px] text-slate-500 mt-0.5">This copy is licensed to one machine. {licenseStatus.message}</p>
                      </div>
                    </div>
                    <span className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full ${
                      licenseStatus.state === 'licensed' ? 'text-green-600 bg-green-500/10 border border-green-500/20'
                      : licenseStatus.state === 'trial' || licenseStatus.state === 'grace' ? 'text-amber-600 bg-amber-500/10 border border-amber-500/20'
                      : 'text-red-500 bg-red-500/10 border border-red-500/20'}`}>
                      {licenseStatus.state}{licenseStatus.daysLeft != null ? ` · ${licenseStatus.daysLeft}d` : ''}
                    </span>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-1">
                      <p className="text-[10px] uppercase font-black text-slate-500">Machine Fingerprint</p>
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-[11px] font-mono font-bold text-slate-800 dark:text-slate-200 select-all break-all">{licenseStatus.fingerprint}</code>
                        <button onClick={copyFingerprint} title="Copy" className="shrink-0 p-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-lg text-slate-500 hover:text-blue-500 active-shrink transition-all cursor-pointer"><Download size={13} /></button>
                      </div>
                      <p className="text-[10px] text-slate-500">Give this to your vendor to get a key for this computer.</p>
                    </div>
                    <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-1.5 text-[11px]">
                      {licenseStatus.licensee && <div className="flex justify-between"><span className="text-slate-500">Licensed to</span><span className="font-bold text-slate-700 dark:text-slate-300">{licenseStatus.licensee}</span></div>}
                      {licenseStatus.plan && <div className="flex justify-between"><span className="text-slate-500">Plan</span><span className="font-bold text-slate-700 dark:text-slate-300">{licenseStatus.plan}</span></div>}
                      <div className="flex justify-between"><span className="text-slate-500">Expires</span><span className="font-bold text-slate-700 dark:text-slate-300">{licenseStatus.expiresAt ? new Date(licenseStatus.expiresAt).toLocaleDateString() : (licenseStatus.state === 'licensed' ? 'Never' : '—')}</span></div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-black text-slate-500">
                      {licenseStatus.state === 'licensed' ? 'Replace / renew license key' : 'Activate a license key'}
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <textarea
                        value={licenseKeyInput}
                        onChange={e => setLicenseKeyInput(e.target.value)}
                        rows={2}
                        placeholder="Paste license key…"
                        className="flex-1 bg-neo shadow-neo-inset-sm border-none rounded-xl p-3 text-[11px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none resize-none"
                      />
                      <button
                        onClick={handleActivateLicense}
                        disabled={activatingLicense}
                        className="sm:w-40 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink transition-all cursor-pointer"
                      >
                        {activatingLicense ? 'Activating…' : 'Activate'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
                </div>
              )}
              </div>
            )
          )}

          {/* TAB: ITEMS & ASSETS */}
          {activeTab === 'inventory' && (
            <div className="space-y-6">
              
              {/* Sub-tabs selector */}
              <div className="bg-neo shadow-neo-outset p-3 rounded-2xl flex items-center space-x-2 w-fit">
                {([
                  { id: 'rentals', label: 'Bulk Rental Items' },
                  { id: 'assets', label: 'Serialized Fleet Assets' },
                  { id: 'consumables', label: 'Consumable Stock' }
                ] as const).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setConsSubTab(tab.id)}
                    className={`px-4 py-2 text-xs font-bold rounded-xl active-shrink transition-all ${
                      consSubTab === tab.id 
                        ? 'bg-neo shadow-neo-inset text-blue-600 dark:text-blue-400 font-bold' 
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Toolbar */}
              <div className="bg-neo shadow-neo-outset p-4 rounded-2xl flex items-center justify-between gap-4">
                <div className="flex space-x-3">
                  {consSubTab === 'rentals' && (
                    <button 
                      onClick={() => setShowItemModal(true)}
                      className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>New Bulk Item</span>
                    </button>
                  )}
                  {consSubTab === 'assets' && (
                    <button 
                      onClick={() => setShowAssetModal(true)}
                      className="bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-slate-800 dark:text-slate-200 font-bold text-xs px-4 py-2.5 rounded-xl flex items-center space-x-1.5 active-shrink transition-all cursor-pointer border border-[#cbd5e1]/10 dark:border-slate-800/10"
                    >
                      <Plus size={14} className="text-blue-500" />
                      <span>New Serialized Asset</span>
                    </button>
                  )}
                  {consSubTab === 'consumables' && (
                    <button 
                      onClick={() => setShowConsumableModal(true)}
                      className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg hover:shadow-blue-500/25 flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>New Consumable</span>
                    </button>
                  )}
                </div>

                {(() => {
                  const target = consSubTab === 'assets' ? 'assets' : consSubTab === 'consumables' ? 'consumables' : 'items';
                  const label = consSubTab === 'assets' ? 'Serialized Assets' : consSubTab === 'consumables' ? 'Consumables' : 'Catalog Items';
                  return (
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => { setImportTarget(target); setShowImportModal(true); }}
                        className="bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs px-3 py-2.5 rounded-xl active-shrink transition-all cursor-pointer font-medium"
                        title={`Import ${label} from CSV`}
                      >
                        Import CSV
                      </button>
                      <button
                        onClick={() => handleExportCSV(target)}
                        className="bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-600 dark:text-slate-400 font-bold text-xs px-3 py-2.5 rounded-xl active-shrink transition-all cursor-pointer font-medium"
                        title={`Export ${label} to CSV`}
                      >
                        Export CSV
                      </button>
                    </div>
                  );
                })()}
              </div>

              {/* RENTAL ITEMS SUB-TAB */}
              {consSubTab === 'rentals' && (
                <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl space-y-4">
                  <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase border-b border-slate-200/10 pb-2">Bulk Inventory Items</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                          <th className="p-2">Name</th>
                          <th className="p-2">Category</th>
                          <th className="p-2 text-right">Daily Rate</th>
                          <th className="p-2 text-center">Stock</th>
                          <th className="p-2 text-right">Tax &amp; URA</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/10">
                        {items.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="p-4 text-center text-slate-400">No catalog items created yet.</td>
                          </tr>
                        ) : (
                          items.map(item => (
                            <tr key={item.id} className="hover:bg-slate-200/5">
                              <td className="p-2 font-bold text-slate-800 dark:text-slate-200">{item.name}</td>
                              <td className="p-2 text-slate-500">{item.category}</td>
                              <td className="p-2 text-right font-mono font-bold text-green-600 dark:text-green-400">
                                {activeCompany.currency || 'UGX'} {Number(item.dailyRentalRate).toLocaleString()}
                              </td>
                              <td className="p-2 text-center font-mono font-bold">{item.currentStock} {item.unitOfMeasure}s</td>
                              <td className="p-2 text-right">
                                {renderTaxUraCell({ kind: 'item', ...(item as any) })}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* SERIALIZED ASSETS SUB-TAB */}
              {consSubTab === 'assets' && (
                <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl space-y-4">
                  <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase border-b border-slate-200/10 pb-2">Serialized Tracked Assets</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                          <th className="p-2">Asset Name</th>
                          <th className="p-2">Serial Number</th>
                          <th className="p-2 text-right">Daily Rate</th>
                          <th className="p-2 text-center">Status</th>
                          <th className="p-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/10">
                        {assets.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="p-4 text-center text-slate-400">No tracked assets created yet.</td>
                          </tr>
                        ) : (
                          assets.map(asset => (
                            <tr key={asset.id} className="hover:bg-slate-200/5">
                              <td className="p-2 font-bold text-slate-800 dark:text-slate-200">{asset.name}</td>
                              <td className="p-2 font-mono">{asset.serialNumber}</td>
                              <td className="p-2 text-right font-mono font-bold text-green-600 dark:text-green-400">
                                {activeCompany.currency || 'UGX'} {Number(asset.dailyRentalRate).toLocaleString()}
                              </td>
                              <td className="p-2 text-center">
                                <select 
                                  value={asset.status} 
                                  onChange={(e) => handleUpdateAssetStatus(asset.id, e.target.value)}
                                  className={`text-[10px] font-bold p-1 rounded-lg bg-neo shadow-neo-outset border-none text-center focus:outline-none cursor-pointer ${
                                    asset.status === 'Available' ? 'text-green-600' :
                                    asset.status === 'Rented' ? 'text-blue-500' :
                                    asset.status === 'Maintenance' ? 'text-amber-500' :
                                    'text-red-500'
                                  }`}
                                >
                                  <option value="Available">Available</option>
                                  <option value="Rented">Rented</option>
                                  <option value="Maintenance">Maintenance</option>
                                  <option value="Damaged">Damaged</option>
                                  <option value="Lost">Lost</option>
                                </select>
                              </td>
                              <td className="p-2 text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                  {renderTaxUraCell({ kind: 'asset', ...(asset as any) })}
                                  <button
                                    onClick={() => handleOpenAssetMaintenance(asset)}
                                    className="px-2 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[9px] font-bold text-amber-600 dark:text-amber-400 rounded-lg active-shrink transition-all"
                                  >
                                    🔧 Maintenance
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* CONSUMABLE STOCK SUB-TAB */}
              {consSubTab === 'consumables' && (
                <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-5 rounded-2xl space-y-4">
                  <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase border-b border-slate-200/10 pb-2">Consumable Non-Serialized Stock</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                          <th className="p-2">Item Name</th>
                          <th className="p-2">SKU</th>
                          <th className="p-2">Category</th>
                          <th className="p-2 text-center">Stock Level</th>
                          <th className="p-2 text-right">Cost Price</th>
                          <th className="p-2 text-right">Retail Price</th>
                          <th className="p-2 text-right">Operations</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/10">
                        {consumables.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="p-4 text-center text-slate-400">No consumable items registered yet.</td>
                          </tr>
                        ) : (
                          consumables.map(item => {
                            const isLowStock = item.stockQty <= item.restockLevel;
                            
                            // Helper to format stock quantity with packages and pieces
                            const getStockQtyLabel = () => {
                              if (item.isMultiUnit && item.unitRatio > 1) {
                                const packages = Math.floor(item.stockQty / item.unitRatio);
                                const remainder = item.stockQty % item.unitRatio;
                                const pkgAbbrev = item.packageUnit?.abbreviation || 'Pkg';
                                const pieceAbbrev = item.pieceUnit?.abbreviation || 'Pcs';
                                
                                if (packages > 0) {
                                  return `${packages} ${pkgAbbrev}` + (remainder > 0 ? `, ${remainder} ${pieceAbbrev}` : '');
                                }
                                  return `${item.stockQty} ${pieceAbbrev}`;
                              }
                              return `${item.stockQty} ${item.unitOfMeasure?.abbreviation || 'units'}`;
                            };

                            // Helper to format price label
                            const getPriceLabel = () => {
                              const currencySymbol = activeCompany.currency || 'UGX';
                              if (item.isMultiUnit) {
                                const pkgAbbrev = item.packageUnit?.abbreviation || 'Pkg';
                                const pieceAbbrev = item.pieceUnit?.abbreviation || 'Pcs';
                                return (
                                  <div className="text-right leading-tight">
                                    <p className="font-bold text-slate-800 dark:text-slate-250">{currencySymbol} {Number(item.packagePrice).toLocaleString()} / {pkgAbbrev}</p>
                                    <span className="text-[10px] text-slate-400 font-mono">({currencySymbol} {Number(item.unitPrice).toLocaleString()} / {pieceAbbrev})</span>
                                  </div>
                                );
                              }
                              return `${currencySymbol} ${Number(item.unitPrice).toLocaleString()} / ${item.unitOfMeasure?.abbreviation || 'unit'}`;
                            };

                            return (
                              <tr key={item.id} className="hover:bg-slate-200/5">
                                <td className="p-2 font-bold text-slate-800 dark:text-slate-200">{item.name}</td>
                                <td className="p-2 font-mono text-slate-500">{item.sku || 'N/A'}</td>
                                <td className="p-2 capitalize text-slate-500">{item.category}</td>
                                <td className="p-2 text-center font-mono font-bold">
                                  <span className={`px-2 py-0.5 rounded-full ${
                                    isLowStock 
                                      ? 'text-red-600 bg-red-500/15 border border-red-500/20' 
                                      : 'text-slate-700 dark:text-slate-350'
                                  }`}>
                                    {getStockQtyLabel()}
                                  </span>
                                  {isLowStock && (
                                    <span className="text-[9px] text-red-500 block font-bold mt-1">
                                      ⚠️ Low Stock Alert (Min: {item.restockLevel})
                                    </span>
                                  )}
                                </td>
                                <td className="p-2 text-right font-mono text-slate-500">
                                  {activeCompany.currency || 'UGX'} {Number(item.costPrice).toLocaleString()}
                                </td>
                                <td className="p-2 text-right font-mono font-bold text-slate-800 dark:text-slate-200">
                                  {getPriceLabel()}
                                </td>
                                <td className="p-2 text-right">
                                  <div className="flex items-center justify-end space-x-1.5">
                                    <button
                                      onClick={() => {
                                        setSelectedConsumable(item);
                                        setConsUseQty('');
                                        setConsUseNotes('');
                                        setShowConsumableUseModal(true);
                                      }}
                                      className="px-2 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[9px] font-bold text-orange-600 rounded-lg active-shrink transition-all"
                                    >
                                      ✏️ Use Stock
                                    </button>
                                    <button
                                      onClick={() => {
                                        setSelectedConsumable(item);
                                        setConsRestockQty('');
                                        setConsRestockCost(item.costPrice.toString());
                                        setConsRestockNotes('');
                                        setShowConsumableRestockModal(true);
                                      }}
                                      className="px-2 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[9px] font-bold text-blue-600 rounded-lg active-shrink transition-all"
                                    >
                                      📦 Restock
                                    </button>
                                    <button
                                      onClick={async () => {
                                        setSelectedConsumable(item);
                                        await fetchConsumableLogs(item.id);
                                        setShowConsumableLogsModal(true);
                                      }}
                                      className="px-2 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[9px] font-bold text-slate-500 rounded-lg active-shrink transition-all"
                                    >
                                      📋 Logs
                                    </button>
                                    {renderTaxUraCell({ kind: 'consumable', ...(item as any) })}
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

            </div>
          )}

        </div>
      </main>

      {/* ADD EMPLOYEE MODAL */}
      {showEmployeeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">New Employee</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Register a staff member in the directory</p>
              </div>
              <button
                onClick={() => setShowEmployeeModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Full Name *</label>
                <input
                  type="text"
                  value={newEmpName}
                  onChange={e => setNewEmpName(e.target.value)}
                  placeholder="E.g. James Kigozi"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Roster Designation / Role</label>
                <input
                  type="text"
                  value={newEmpRole}
                  onChange={e => setNewEmpRole(e.target.value)}
                  placeholder="E.g. Usher Team Lead"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Billing Rate to Client (UGX)</label>
                  <input
                    type="number"
                    value={newEmpBillingRate}
                    onChange={e => setNewEmpBillingRate(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Pay Rate to Staff (UGX)</label>
                  <input
                    type="number"
                    value={newEmpPayRate}
                    onChange={e => setNewEmpPayRate(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Payroll Structure</label>
                <select
                  value={newEmpPayStructure}
                  onChange={e => setNewEmpPayStructure(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="Per Function">Per Function</option>
                  <option value="Daily">Daily</option>
                  <option value="Monthly">Monthly</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowEmployeeModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateEmployee}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Add Employee
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD SITE MODAL */}
      {showSiteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">New Job Site</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Register a job site or event location</p>
              </div>
              <button
                onClick={() => setShowSiteModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Site Name *</label>
                <input
                  type="text"
                  value={newSiteName}
                  onChange={e => setNewSiteName(e.target.value)}
                  placeholder="E.g. Speke Resort Lakeside Lawns"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Address / Location</label>
                <input
                  type="text"
                  value={newSiteLocation}
                  onChange={e => setNewSiteLocation(e.target.value)}
                  placeholder="E.g. Munyonyo, Kampala"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Contact Person</label>
                  <input
                    type="text"
                    value={newSiteContactPerson}
                    onChange={e => setNewSiteContactPerson(e.target.value)}
                    placeholder="E.g. Manager Isaac"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Contact Tel / Email</label>
                  <input
                    type="text"
                    value={newSiteContactInfo}
                    onChange={e => setNewSiteContactInfo(e.target.value)}
                    placeholder="E.g. +256 701 445566"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Access Notes / Directions</label>
                <textarea
                  value={newSiteNotes}
                  onChange={e => setNewSiteNotes(e.target.value)}
                  placeholder="E.g. Access from secondary cargo bay only."
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none h-16 resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowSiteModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSite}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Add Site
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ASSIGN SITE EMPLOYEE MODAL */}
      {showAssignSiteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-sm space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Assign Staff to Site</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Link an employee to this job site</p>
              </div>
              <button
                onClick={() => { setShowAssignSiteModal(false); setAssignSiteId(null); }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Select Employee *</label>
                <select
                  value={assignSiteEmployeeId}
                  onChange={e => setAssignSiteEmployeeId(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="">-- Choose Employee --</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.name} ({emp.role || 'No Designation'})</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center space-x-2.5 py-1">
                <input
                  type="checkbox"
                  id="primary_site"
                  checked={assignSiteIsPrimary}
                  onChange={e => setAssignSiteIsPrimary(e.target.checked)}
                  className="accent-blue-600"
                />
                <label htmlFor="primary_site" className="text-[11px] font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
                  Mark as Primary Worksite
                </label>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Assignment Notes</label>
                <input
                  type="text"
                  value={assignSiteNotes}
                  onChange={e => setAssignSiteNotes(e.target.value)}
                  placeholder="E.g. Primary sound engineer"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => { setShowAssignSiteModal(false); setAssignSiteId(null); }}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleAssignSite}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Save Assignment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PLAN EVENT MODAL */}
      {showEventModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Plan Event</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Schedule a ceremony or function setup</p>
              </div>
              <button
                onClick={() => setShowEventModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Event / Ceremony Name *</label>
                <input
                  type="text"
                  value={newEventName}
                  onChange={e => setNewEventName(e.target.value)}
                  placeholder="E.g. Mukasa Memorial Ceremony"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Scheduled Date *</label>
                  <input
                    type="date"
                    value={newEventDate}
                    onChange={e => setNewEventDate(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Scheduled Time</label>
                  <input
                    type="text"
                    value={newEventTime}
                    onChange={e => setNewEventTime(e.target.value)}
                    placeholder="E.g. 10:00 AM"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Location / Worksite *</label>
                <input
                  type="text"
                  value={newEventLocation}
                  onChange={e => setNewEventLocation(e.target.value)}
                  placeholder="E.g. Speke Resort Lakeside Lawns"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Client Contact Name</label>
                  <input
                    type="text"
                    value={newEventClientName}
                    onChange={e => setNewEventClientName(e.target.value)}
                    placeholder="E.g. David Mukasa"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Client Phone / Email</label>
                  <input
                    type="text"
                    value={newEventClientContact}
                    onChange={e => setNewEventClientContact(e.target.value)}
                    placeholder="E.g. +256 772 123456"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Setup Instructions / Notes</label>
                <textarea
                  value={newEventNotes}
                  onChange={e => setNewEventNotes(e.target.value)}
                  placeholder="Details about decor, layouts, equipment list..."
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none h-16 resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowEventModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateEvent}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Plan Event
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ASSIGN STAFF SHIFT MODAL */}
      {showAssignStaffModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-sm space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Assign Staff Role</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Assign employee shift to event</p>
              </div>
              <button
                onClick={() => { setShowAssignStaffModal(false); setAssignEventId(null); }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Select Employee *</label>
                <select
                  value={assignEmployeeId}
                  onChange={e => setAssignEmployeeId(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="">-- Choose Employee --</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.name} ({emp.role || 'No Designation'})</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Function Role *</label>
                <select
                  value={assignRoleId}
                  onChange={e => setAssignRoleId(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="">-- Choose Role --</option>
                  {functionRoles.map(role => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Start Time</label>
                  <input
                    type="text"
                    value={assignStartTime}
                    onChange={e => setAssignStartTime(e.target.value)}
                    placeholder="E.g. 08:00 AM"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">End Time</label>
                  <input
                    type="text"
                    value={assignEndTime}
                    onChange={e => setAssignEndTime(e.target.value)}
                    placeholder="E.g. 04:00 PM"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Shift Instructions</label>
                <input
                  type="text"
                  value={assignNotes}
                  onChange={e => setAssignNotes(e.target.value)}
                  placeholder="Shift-specific duties..."
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => { setShowAssignStaffModal(false); setAssignEventId(null); }}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleAssignStaff}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Assign Staff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD SUPPLIER MODAL */}
      {showSupplierModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">New Supplier</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Register a supplier in the directory</p>
              </div>
              <button
                onClick={() => setShowSupplierModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Supplier Name *</label>
                <input
                  type="text"
                  value={newSupplierName}
                  onChange={e => setNewSupplierName(e.target.value)}
                  placeholder="E.g. Elite Tent Manufacturers Ltd"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Contact Person</label>
                <input
                  type="text"
                  value={newSupplierPerson}
                  onChange={e => setNewSupplierPerson(e.target.value)}
                  placeholder="E.g. Mr. Moses Kintu"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Phone Number</label>
                  <input
                    type="text"
                    value={newSupplierPhone}
                    onChange={e => setNewSupplierPhone(e.target.value)}
                    placeholder="E.g. +256 702 334455"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Email Address</label>
                  <input
                    type="email"
                    value={newSupplierEmail}
                    onChange={e => setNewSupplierEmail(e.target.value)}
                    placeholder="E.g. sales@elitetents.ug"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Office Address</label>
                <input
                  type="text"
                  value={newSupplierAddress}
                  onChange={e => setNewSupplierAddress(e.target.value)}
                  placeholder="E.g. Kibuye Road, Kampala"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Notes / Terms</label>
                <textarea
                  value={newSupplierNotes}
                  onChange={e => setNewSupplierNotes(e.target.value)}
                  placeholder="Payment terms, special discounts..."
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none h-16 resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowSupplierModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSupplier}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Add Supplier
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CREATE PURCHASE ORDER MODAL */}
      {showPOModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-lg space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Create Purchase Order</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Request catalog stock replenishment from supplier</p>
              </div>
              <button
                onClick={() => setShowPOModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4 max-h-[350px] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Supplier *</label>
                  <select
                    value={newPOSupplierId}
                    onChange={e => setNewPOSupplierId(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  >
                    <option value="">-- Choose Supplier --</option>
                    {suppliers.map(sup => (
                      <option key={sup.id} value={sup.id}>{sup.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">PO Number *</label>
                  <input
                    type="text"
                    value={newPONumber}
                    onChange={e => setNewPONumber(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Order Date *</label>
                  <input
                    type="date"
                    value={newPODate}
                    onChange={e => setNewPODate(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Estimated Delivery</label>
                  <input
                    type="date"
                    value={newPODeliveryDate}
                    onChange={e => setNewPODeliveryDate(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              {/* Line Items Builder */}
              <div className="border-t border-slate-200/10 pt-3 space-y-2">
                <div className="flex justify-between items-center">
                  <p className="text-[10px] font-bold uppercase text-slate-500">PO Line Items</p>
                  <button
                    onClick={() => setNewPOLineItems([...newPOLineItems, { itemId: '', description: '', quantity: 1, unitCost: 0 }])}
                    className="text-[10px] font-bold text-blue-600 flex items-center space-x-1"
                  >
                    <Plus size={11} />
                    <span>Add Item Line</span>
                  </button>
                </div>

                {newPOLineItems.map((li, idx) => (
                  <div key={idx} className="bg-neo shadow-neo-inset-sm p-3 rounded-xl space-y-2 relative">
                    <button
                      onClick={() => setNewPOLineItems(newPOLineItems.filter((_, i) => i !== idx))}
                      className="absolute top-2 right-2 text-red-500 hover:text-red-700"
                    >
                      <X size={12} />
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold block">Catalog Item (Optional)</label>
                        <select
                          value={li.itemId}
                          onChange={e => {
                            const val = e.target.value;
                            const matched = items.find(it => it.id === parseInt(val));
                            const desc = matched ? matched.name : li.description;
                            const cost = matched ? Number(matched.unitCost) : li.unitCost;
                            const updated = [...newPOLineItems];
                            updated[idx] = { ...li, itemId: val, description: desc, unitCost: cost };
                            setNewPOLineItems(updated);
                          }}
                          className="w-full bg-neo shadow-neo-outset border-none p-1.5 rounded-lg text-[11px] text-slate-700 focus:outline-none"
                        >
                          <option value="">-- Direct Buy (No Catalog) --</option>
                          {items.map(it => (
                            <option key={it.id} value={it.id}>{it.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold block">Description *</label>
                        <input
                          type="text"
                          value={li.description}
                          onChange={e => {
                            const updated = [...newPOLineItems];
                            updated[idx].description = e.target.value;
                            setNewPOLineItems(updated);
                          }}
                          placeholder="White plastic chairs..."
                          className="w-full bg-neo shadow-neo-outset border-none p-1.5 rounded-lg text-[11px] text-slate-700 focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold block">Quantity *</label>
                        <input
                          type="number"
                          value={li.quantity}
                          onChange={e => {
                            const updated = [...newPOLineItems];
                            updated[idx].quantity = parseInt(e.target.value) || 0;
                            setNewPOLineItems(updated);
                          }}
                          className="w-full bg-neo shadow-neo-outset border-none p-1.5 rounded-lg text-[11px] text-slate-700 focus:outline-none font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold block">Unit Cost (UGX) *</label>
                        <input
                          type="number"
                          value={li.unitCost}
                          onChange={e => {
                            const updated = [...newPOLineItems];
                            updated[idx].unitCost = Number(e.target.value) || 0;
                            setNewPOLineItems(updated);
                          }}
                          className="w-full bg-neo shadow-neo-outset border-none p-1.5 rounded-lg text-[11px] text-slate-700 focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-1 border-t border-slate-200/10 pt-3">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">PO Notes / Instruction</label>
                <input
                  type="text"
                  value={newPONotes}
                  onChange={e => setNewPONotes(e.target.value)}
                  placeholder="Restocking chairs, generator spare parts..."
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowPOModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreatePO}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Create PO
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LOG EXPENSE MODAL */}
      {showExpenseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Log Expense</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Record business operating expenses</p>
              </div>
              <button
                onClick={() => setShowExpenseModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Expense Category *</label>
                  <select
                    value={newExpCategory}
                    onChange={e => setNewExpCategory(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  >
                    <option value="Fuel">Fuel</option>
                    <option value="Rent">Rent</option>
                    <option value="Repair & Maintenance">Repair & Maintenance</option>
                    <option value="Utilities">Utilities</option>
                    <option value="Marketing">Marketing</option>
                    <option value="Staff Expenses">Staff Expenses</option>
                    <option value="Other Office Expenses">Other Office Expenses</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Supplier Reference</label>
                  <select
                    value={newExpSupplierId}
                    onChange={e => setNewExpSupplierId(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  >
                    <option value="">-- No Supplier (Out-of-pocket) --</option>
                    {suppliers.map(sup => (
                      <option key={sup.id} value={sup.id}>{sup.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Amount Paid (UGX) *</label>
                  <input
                    type="number"
                    value={newExpAmount}
                    onChange={e => setNewExpAmount(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Expense Date *</label>
                  <input
                    type="date"
                    value={newExpDate}
                    onChange={e => setNewExpDate(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Payment Method *</label>
                <select
                  value={newExpPaymentMethod}
                  onChange={e => setNewExpPaymentMethod(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="Cash">Cash</option>
                  <option value="Mobile Money">Mobile Money</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Notes / Description</label>
                <textarea
                  value={newExpNotes}
                  onChange={e => setNewExpNotes(e.target.value)}
                  placeholder="Specify fuel quantities, utility bill references, rent period details..."
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none h-16 resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowExpenseModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateExpense}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Log Expense
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CREATE PAYROLL PERIOD MODAL */}
      {showPayrollPeriodModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-sm space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Run Payroll Period</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Aggregate employee shifts into a payroll run</p>
              </div>
              <button
                onClick={() => setShowPayrollPeriodModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Cycle Start Date *</label>
                <input
                  type="date"
                  value={newPayrollStart}
                  onChange={e => setNewPayrollStart(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Cycle End Date *</label>
                <input
                  type="date"
                  value={newPayrollEnd}
                  onChange={e => setNewPayrollEnd(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowPayrollPeriodModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreatePayrollPeriod}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Run Shift Payroll
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECORD PAYROLL PAYMENT MODAL */}
      {showPayEmployeeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-sm space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Record Payout</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Pay worker shift wage</p>
              </div>
              <button
                onClick={() => { setShowPayEmployeeModal(false); setPayEmployeePaymentId(null); }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Payment Date *</label>
                <input
                  type="date"
                  value={payEmployeeDate}
                  onChange={e => setPayEmployeeDate(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Payout Channel *</label>
                <select
                  value={payEmployeeMethod}
                  onChange={e => setPayEmployeeMethod(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="Cash">Cash Handout</option>
                  <option value="Mobile Money">Mobile Money (MTN/Airtel)</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Tx Reference / Notes</label>
                <input
                  type="text"
                  value={payEmployeeNotes}
                  onChange={e => setPayEmployeeNotes(e.target.value)}
                  placeholder="Mobile money txn reference..."
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => { setShowPayEmployeeModal(false); setPayEmployeePaymentId(null); }}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handlePayEmployee}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Confirm Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECORD INVOICE PAYMENT MODAL */}
      {showPayInvoiceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-sm space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Record Invoice Payment</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Log direct customer payout amount</p>
              </div>
              <button
                onClick={() => { setShowPayInvoiceModal(false); setPayInvoiceId(null); }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Payment Date *</label>
                <input
                  type="date"
                  value={payInvoiceDate}
                  onChange={e => setPayInvoiceDate(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Payment Channel *</label>
                <select
                  value={payInvoiceMethod}
                  onChange={e => setPayInvoiceMethod(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="Cash">Cash payment</option>
                  <option value="Mobile Money">Mobile Money (MTN/Airtel)</option>
                  <option value="Bank Transfer">Bank Wire Transfer</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Amount received</label>
                <input
                  type="number"
                  min={0}
                  value={payInvoiceAmount}
                  onChange={e => setPayInvoiceAmount(e.target.value)}
                  placeholder={(() => {
                    const inv = invoices.find(i => i.id === payInvoiceId);
                    const bal = inv ? (inv.balanceDue ?? Number(inv.amount) - Number(inv.amountPaid || 0)) : 0;
                    return `Full balance — ${Number(bal).toLocaleString()}`;
                  })()}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
                />
                <p className="text-[9px] text-slate-400">Leave blank to settle the whole balance. A smaller figure records a part payment.</p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Tx Reference / notes</label>
                <input
                  type="text"
                  value={payInvoiceNotes}
                  onChange={e => setPayInvoiceNotes(e.target.value)}
                  placeholder="Bank slips, slip receipt numbers..."
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => { setShowPayInvoiceModal(false); setPayInvoiceId(null); }}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handlePayInvoice}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Submit Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tax & URA details for one catalogue entry */}
      {taxTarget && (
        <CatalogTaxModal
          apiUrl={API_URL}
          companyId={selectedCompanyId}
          target={taxTarget}
          taxRates={taxRatesList}
          units={uoms as any}
          efrisReady={efrisConfig.enabled && efrisConfig.configured}
          onClose={() => setTaxTarget(null)}
          onSaved={async () => { await fetchAllData(); await refreshTaxRates(); }}
        />
      )}

      {/* CREDIT MEMO — URA needs a reason code, not just a note */}
      {creditMemoInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Issue Credit Note</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Against {creditMemoInvoice.referenceNumber} · {fmtMoney(creditMemoInvoice.amount, bizSettings.currency)}
                </p>
              </div>
              <button
                onClick={() => setCreditMemoInvoice(null)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            {creditMemoInvoice.efrisFDN && (
              <p className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-500/10 rounded-lg p-2.5 leading-relaxed">
                This invoice was fiscalized with URA, so the credit note is reported to URA in the
                same step — that is how a fiscalized invoice gets corrected.
              </p>
            )}

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">URA reason *</label>
                <select
                  value={creditMemoCode}
                  onChange={e => setCreditMemoCode(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  {CREDIT_NOTE_REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Explanation</label>
                <textarea
                  value={creditMemoReason}
                  onChange={e => setCreditMemoReason(e.target.value)}
                  rows={2}
                  placeholder="What happened, in your own words"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setCreditMemoInvoice(null)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={submitCreditMemo}
                disabled={issuingCreditMemo}
                className="bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg active-shrink cursor-pointer disabled:opacity-60"
              >
                {issuingCreditMemo ? 'Issuing…' : 'Issue Credit Note'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* THE URA FISCAL INVOICE, as it must be presented */}
      {fiscalInvoice && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm overflow-y-auto py-8 px-4">
          <div className="w-full max-w-2xl space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-white">Fiscal Invoice — {fiscalInvoice.referenceNumber}</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => openServerPdf(`/api/invoices/${fiscalInvoice.id}/pdf`)}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-bold text-white active-shrink cursor-pointer"
                >
                  PDF
                </button>
                <button
                  onClick={() => setFiscalInvoice(null)}
                  className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white active-shrink cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            <FiscalInvoice
              invoice={fiscalInvoice}
              company={{
                name: currentUser?.company?.name || '',
                address: (currentUser?.company as any)?.address,
                efrisTin: efrisConfig.tin,
              }}
            />
          </div>
        </div>
      )}

      {/* SUBSCRIPTION BILLING & STRIPE UPGRADE MODAL */}
      {showBillingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-xl space-y-6 max-h-[90vh] overflow-y-auto animate-fade-in border border-slate-200/5">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Upgrade Subscription Plan</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Select a subscription plan and complete Stripe simulation checkout</p>
              </div>
              <button
                onClick={() => { setShowBillingModal(false); setSelectedPlanToUpgrade(null); }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {subscriptionPlans.map((plan) => {
                const isActive = currentUser?.company?.planId === plan.id;
                const isSelected = selectedPlanToUpgrade?.id === plan.id;
                return (
                  <button
                    key={plan.id}
                    onClick={() => {
                      if (!isActive) setSelectedPlanToUpgrade(plan);
                    }}
                    disabled={isActive}
                    className={`p-4 rounded-2xl text-left transition-all relative flex flex-col justify-between h-32 ${
                      isActive 
                        ? 'bg-blue-600/5 border border-blue-500/30 shadow-none cursor-default opacity-85'
                        : isSelected
                          ? 'bg-neo border-2 border-blue-600 shadow-neo-inset-sm'
                          : 'bg-neo border border-transparent shadow-neo-outset hover:shadow-neo-inset-sm cursor-pointer'
                    }`}
                  >
                    {isActive && (
                      <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-600 dark:text-blue-400 text-[8px] font-black uppercase">
                        Active
                      </span>
                    )}
                    <div className="space-y-1">
                      <h4 className="text-[11px] font-black text-slate-800 dark:text-white uppercase">{plan.name}</h4>
                      <p className="text-xs font-black text-blue-600 dark:text-blue-400">
                        {plan.priceMonthly === 0 ? 'Free' : `UGX ${Number(plan.priceMonthly).toLocaleString()}/mo`}
                      </p>
                    </div>

                    <div className="mt-2 pt-2 border-t border-slate-200/5 text-[9px] text-slate-500 dark:text-slate-400 space-y-0.5">
                      <div>• Up to <strong className="text-slate-700 dark:text-slate-300">{plan.maxUsers || 'Unlimited'}</strong> Users</div>
                      <div>• Up to <strong className="text-slate-700 dark:text-slate-300">{plan.maxItems || 'Unlimited'}</strong> Items</div>
                    </div>
                  </button>
                );
              })}
            </div>

            {selectedPlanToUpgrade && (
              <div className="bg-neo shadow-neo-inset-sm rounded-2xl p-5 border border-transparent space-y-4 animate-fade-in text-left">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase font-bold text-slate-500">Stripe Secure Test Checkout</span>
                  <span className="text-[9px] text-slate-400 font-medium">💳 Card Payment</span>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[9px] uppercase font-bold text-slate-400">Cardholder Name</label>
                    <input
                      type="text"
                      value={stripeCardName}
                      onChange={(e) => setStripeCardName(e.target.value)}
                      placeholder="e.g. Mega Rentals Billing Account"
                      className="w-full bg-neo shadow-neo-outset border border-slate-200/5 p-2 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[9px] uppercase font-bold text-slate-400">Card Number</label>
                    <div className="relative">
                      <input
                        type="text"
                        value={stripeCardNumber}
                        onChange={(e) => setStripeCardNumber(e.target.value)}
                        placeholder="4242 4242 4242 4242"
                        maxLength={19}
                        className="w-full bg-neo shadow-neo-outset border border-slate-200/5 p-2 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono tracking-widest"
                      />
                      <span className="absolute right-3 top-2 text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                        Stripe
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[9px] uppercase font-bold text-slate-400">Expiration</label>
                      <input
                        type="text"
                        value={stripeCardExpiry}
                        onChange={(e) => setStripeCardExpiry(e.target.value)}
                        placeholder="MM / YY"
                        maxLength={5}
                        className="w-full bg-neo shadow-neo-outset border border-slate-200/5 p-2 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono text-center"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] uppercase font-bold text-slate-400">CVC</label>
                      <input
                        type="password"
                        value={stripeCardCVC}
                        onChange={(e) => setStripeCardCVC(e.target.value)}
                        placeholder="•••"
                        maxLength={4}
                        className="w-full bg-neo shadow-neo-outset border border-slate-200/5 p-2 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono text-center"
                      />
                    </div>
                  </div>
                </div>

                <div className="text-[10px] text-slate-500 bg-blue-500/5 p-3 rounded-xl border border-blue-500/10 leading-relaxed">
                  💡 <strong>Test Mode:</strong> You can use any test card details (e.g. Card: <code>4242...</code>, CVC: <code>123</code>, Exp: <code>12/28</code>) to complete the simulation upgrade.
                </div>
              </div>
            )}

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => { setShowBillingModal(false); setSelectedPlanToUpgrade(null); }}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              {selectedPlanToUpgrade && (
                <button
                  onClick={async () => {
                    if (!stripeCardName || !stripeCardNumber) {
                      alert('Please enter card details to authorize upgrade.');
                      return;
                    }
                    try {
                      const res = await fetch(`${API_URL}/api/companies/subscription/upgrade`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'x-company-id': selectedCompanyId.toString()
                        },
                        body: JSON.stringify({
                          companyId: selectedCompanyId,
                          planId: selectedPlanToUpgrade.id,
                          cardHolderName: stripeCardName
                        })
                      });
                      if (res.ok) {
                        const updatedComp = await res.json();
                        const updatedUser = {
                          ...currentUser,
                          company: updatedComp
                        };
                        setCurrentUser(updatedUser);
                        localStorage.setItem('yourhires_session', JSON.stringify({ user: updatedUser.user, company: updatedComp }));
                        
                        setStripeCardName('');
                        setStripeCardNumber('');
                        setStripeCardExpiry('');
                        setStripeCardCVC('');
                        setSelectedPlanToUpgrade(null);
                        setShowBillingModal(false);
                        
                        await fetchAllData();
                        alert(`Successfully upgraded to the ${selectedPlanToUpgrade.name}!`);
                      } else {
                        const err = await res.json();
                        alert(`Upgrade failed: ${err.error || 'Server error'}`);
                      }
                    } catch (e: any) {
                      alert(`Upgrade error: ${e.message}`);
                    }
                  }}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
                >
                  Pay and Upgrade
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* CSV IMPORT MODAL */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-sm space-y-5 animate-fade-in">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white capitalize">Import {importTarget}</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Bulk import records from CSV file</p>
              </div>
              <button
                onClick={() => setShowImportModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 text-[11px] text-slate-500 dark:text-slate-400 space-y-1.5 border border-transparent">
                <p className="font-bold text-slate-700 dark:text-slate-300">Expected Column Headings (CSV):</p>
                <code className="block font-mono text-[10px] bg-slate-200/20 p-1.5 rounded dark:bg-slate-800/20 text-blue-600 dark:text-blue-400 overflow-x-auto">
                  {importTarget === 'customers' && 'name,contactInfo,watchListReason,isOnWatchList'}
                  {importTarget === 'items' && 'name,category,unitOfMeasure,unitCost,unitReplacementCost,dailyRentalRate,currentStock,lowStockThreshold'}
                  {importTarget === 'assets' && 'name,assetType,serialNumber,costPrice,dailyRentalRate,replacementCost,status'}
                  {importTarget === 'consumables' && 'name,category,stockQty,restockLevel,unitPrice,costPrice,sku'}
                  {importTarget === 'employees' && 'name,role,billingRateToClient,payStructure,payRate,isActive'}
                </code>
                <span className="italic block mt-1 text-[10px]">Note: The first row must be the exact header row. True or false values are supported for boolean columns.</span>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Select CSV File</label>
                <div className="flex items-center justify-center border border-dashed border-[#cbd5e1]/30 dark:border-slate-800/30 rounded-xl p-6 bg-neo shadow-neo-inset-sm">
                  <input
                    type="file"
                    accept=".csv,.txt"
                    onChange={handleImportFileChange}
                    className="text-xs text-slate-500 cursor-pointer focus:outline-none file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 active-shrink"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowImportModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* COMPLETE FUNCTION MODAL */}
      {showCompleteFunctionModal && selectedFunctionEvent && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowCompleteFunctionModal(false)}>
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-black text-slate-800 dark:text-white uppercase">Mark Function Complete</h3>
            <p className="text-[11px] text-slate-500">Add a post-event completion summary (optional). This locks the event status as Completed.</p>
            <textarea
              value={completionNotesInput}
              onChange={e => setCompletionNotesInput(e.target.value)}
              rows={4}
              placeholder="e.g. Event ran smoothly, all equipment returned same day, family satisfied with service."
              className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
            />
            <div className="flex justify-end space-x-2">
              <button onClick={() => setShowCompleteFunctionModal(false)} className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer">Cancel</button>
              <button onClick={handleCompleteFunction} className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer">Mark Complete</button>
            </div>
          </div>
        </div>
      )}

      {/* SIGNATURE CAPTURE MODAL */}
      {showSignatureModal && selectedFunctionEvent && (() => {
        let pendingSignature: string | null = null;
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowSignatureModal(false)}>
            <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-black text-slate-800 dark:text-white uppercase">Capture Signature</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Confirmation Type</label>
                  <select value={signatureType} onChange={e => setSignatureType(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer">
                    <option value="pickup">Items Pickup</option>
                    <option value="return">Items Return</option>
                    <option value="function">Function Completion</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Signee Name</label>
                  <input value={signeeName} onChange={e => setSigneeName(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Signee Contact (optional)</label>
                <input value={signeeContact} onChange={e => setSigneeContact(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Sign below</label>
                <SignaturePad onChange={val => { pendingSignature = val; }} />
              </div>
              <div className="flex justify-end space-x-2">
                <button onClick={() => setShowSignatureModal(false)} className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer">Cancel</button>
                <button
                  onClick={() => { if (!pendingSignature) return alert('Please draw a signature first.'); handleSaveSignature(pendingSignature); }}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer"
                >
                  Save Signature
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* FUNCTION TEMPLATES MODAL */}
      {showTemplatesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => { setShowTemplatesModal(false); setCreateFromTemplateId(null); }}>
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white uppercase">Function Templates</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">Reusable event blueprints — save common setups and spin up new events instantly.</p>
              </div>
              <div className="flex items-center space-x-2">
                <button onClick={() => setShowCreateTemplateModal(true)} className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer">+ New Template</button>
                <button onClick={() => { setShowTemplatesModal(false); setCreateFromTemplateId(null); }} className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"><X size={14} /></button>
              </div>
            </div>

            {functionTemplates.length === 0 ? (
              <div className="text-center py-10 text-slate-400 text-xs">No templates yet. Create one to speed up future event setup.</div>
            ) : (
              <div className="space-y-3">
                {functionTemplates.map(t => (
                  <div key={t.id} className="bg-neo shadow-neo-inset-sm rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-black text-slate-800 dark:text-slate-200">{t.name}</p>
                        {t.description && <p className="text-[10px] text-slate-500">{t.description}</p>}
                      </div>
                      <div className="flex items-center space-x-2">
                        <button onClick={() => setCreateFromTemplateId(createFromTemplateId === t.id ? null : t.id)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold rounded-lg active-shrink cursor-pointer">Use Template</button>
                        <button onClick={() => handleDeleteTemplate(t.id)} className="text-red-400 hover:text-red-600 cursor-pointer"><Trash2 size={14} /></button>
                      </div>
                    </div>

                    {/* Template items */}
                    <div className="space-y-1.5">
                      {(t.items || []).map((ti: any) => (
                        <div key={ti.id} className="flex items-center justify-between bg-neo shadow-neo-outset-sm px-2.5 py-1.5 rounded-lg text-[10px]">
                          <span className="text-slate-700 dark:text-slate-300">{ti.item?.name || ti.asset?.name} <span className="text-slate-400">x{ti.quantity}</span></span>
                          <button onClick={() => handleDeleteTemplateItem(ti.id)} className="text-red-400 hover:text-red-600 cursor-pointer"><X size={11} /></button>
                        </div>
                      ))}
                      <TemplateItemAdder items={items} assets={assets} onAdd={(itemType, refId, qty) => handleAddTemplateItem(t.id, itemType, refId, qty)} />
                    </div>

                    {/* Create-from-template inline form */}
                    {createFromTemplateId === t.id && (
                      <CreateFromTemplateForm
                        defaults={{ location: t.defaultLocation, time: t.defaultTime }}
                        onSubmit={(form) => handleCreateFunctionFromTemplate(t.id, form)}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* CREATE TEMPLATE MODAL */}
      {showCreateTemplateModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowCreateTemplateModal(false)}>
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-sm space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-black text-slate-800 dark:text-white uppercase">New Template</h3>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold text-slate-500 block">Template Name</label>
              <input value={newTemplateName} onChange={e => setNewTemplateName(e.target.value)} placeholder="e.g. Standard Memorial Service"
                className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold text-slate-500 block">Description (optional)</label>
              <textarea value={newTemplateDesc} onChange={e => setNewTemplateDesc(e.target.value)} rows={2}
                className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
            </div>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setShowCreateTemplateModal(false)} className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer">Cancel</button>
              <button onClick={handleCreateTemplate} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* QUICK TOUR TUTORIAL MODAL */}
      {showTutorial && (() => {
        const slide = TUTORIAL_SLIDES[tutorialStep];
        const isLast = tutorialStep === TUTORIAL_SLIDES.length - 1;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowTutorial(false)}>
            <div className="bg-neo shadow-neo-outset border border-slate-200/10 rounded-2xl w-full max-w-md p-6 space-y-5 animate-fade-in" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-black uppercase text-blue-500">Step {tutorialStep + 1} of {TUTORIAL_SLIDES.length}</span>
                <button onClick={() => setShowTutorial(false)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X size={16} /></button>
              </div>
              <div className="w-full bg-slate-200/20 dark:bg-slate-800/20 h-1.5 rounded-full overflow-hidden">
                <div className="bg-blue-500 h-full rounded-full transition-all duration-300" style={{ width: `${((tutorialStep + 1) / TUTORIAL_SLIDES.length) * 100}%` }} />
              </div>
              <div className="space-y-2 min-h-[80px]">
                <h3 className="text-sm font-black text-slate-800 dark:text-white">{slide.title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{slide.body}</p>
              </div>
              <div className="flex justify-between items-center pt-2">
                <button
                  onClick={() => setTutorialStep(s => Math.max(0, s - 1))}
                  disabled={tutorialStep === 0}
                  className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  onClick={() => {
                    if (isLast) { setShowTutorial(false); return; }
                    setActiveTab(slide.tab);
                    setTutorialStep(s => s + 1);
                  }}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer"
                >
                  {isLast ? 'Finish' : 'Next'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ADD TEAM MEMBER MODAL */}
      {showAddUserModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !savingUser && setShowAddUserModal(false)}>
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-4 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white uppercase">Add Team Member</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">They can sign in immediately with these credentials.</p>
              </div>
              <button onClick={() => setShowAddUserModal(false)} className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"><X size={14} /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">First Name</label>
                <input value={newUser.firstName} onChange={e => setNewUser(s => ({ ...s, firstName: e.target.value }))} className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Last Name</label>
                <input value={newUser.lastName} onChange={e => setNewUser(s => ({ ...s, lastName: e.target.value }))} className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold text-slate-500 block">Email</label>
              <input type="email" value={newUser.email} onChange={e => setNewUser(s => ({ ...s, email: e.target.value }))} className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Username</label>
                <input value={newUser.username} onChange={e => setNewUser(s => ({ ...s, username: e.target.value }))} className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Role</label>
                <select value={newUser.companyRoleId ?? ''} onChange={e => setNewUser(s => ({ ...s, companyRoleId: e.target.value ? parseInt(e.target.value) : null }))} className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer">
                  <option value="">— Select role —</option>
                  {companyRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold text-slate-500 block">Temporary Password (min 8 chars)</label>
              <input type="text" value={newUser.password} onChange={e => setNewUser(s => ({ ...s, password: e.target.value }))} className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono" />
            </div>
            <div className="flex justify-end space-x-2 border-t border-slate-200/10 pt-4">
              <button onClick={() => setShowAddUserModal(false)} disabled={savingUser} className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer disabled:opacity-50">Cancel</button>
              <button onClick={handleAddUser} disabled={savingUser} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer disabled:opacity-60">{savingUser ? 'Adding…' : 'Add Member'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ROLE EDITOR MODAL (permission matrix) */}
      {showRoleEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-2xl space-y-4 border border-slate-200/5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <h3 className="text-sm font-black text-slate-800 dark:text-slate-200">{editingRole ? `Edit Role — ${editingRole.name}` : 'New Role'}</h3>
              <button onClick={() => setShowRoleEditor(false)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X size={18} /></button>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Role Name</label>
                <input value={roleDraft.name} onChange={e => setRoleDraft(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Cashier, Store Manager" className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Description</label>
                <input value={roleDraft.description} onChange={e => setRoleDraft(d => ({ ...d, description: e.target.value }))} placeholder="Short description" className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Permissions</label>
                <div className="flex gap-2">
                  <button onClick={() => setRoleDraft(d => { const p: any = {}; for (const m of permCatalog) { p[m.key] = {}; for (const a of m.actions) p[m.key][a] = true; } return { ...d, permissions: p }; })} className="text-[10px] font-bold text-blue-600 dark:text-blue-400 cursor-pointer hover:underline">Select all</button>
                  <button onClick={() => setRoleDraft(d => ({ ...d, permissions: emptyMatrix() }))} className="text-[10px] font-bold text-slate-500 cursor-pointer hover:underline">Clear all</button>
                </div>
              </div>
              <div className="bg-neo shadow-neo-inset-sm rounded-xl p-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[9px] text-slate-500 uppercase font-black">
                      <th className="p-2">Module</th>
                      {['view', 'create', 'edit', 'delete', 'manage'].map(a => <th key={a} className="p-2 text-center">{a}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/10">
                    {permCatalog.map(mod => (
                      <tr key={mod.key} className="hover:bg-slate-200/5">
                        <td className="p-2 font-bold text-slate-700 dark:text-slate-300">
                          {mod.label}
                          {mod.financial && <span className="ml-1 text-[8px] font-black uppercase text-amber-500">$</span>}
                        </td>
                        {['view', 'create', 'edit', 'delete', 'manage'].map(a => (
                          <td key={a} className="p-2 text-center">
                            {mod.actions.includes(a) ? (
                              <input
                                type="checkbox"
                                checked={!!roleDraft.permissions[mod.key]?.[a]}
                                onChange={() => toggleRolePerm(mod.key, a)}
                                className="w-4 h-4 accent-blue-600 cursor-pointer"
                              />
                            ) : (
                              <span className="text-slate-300 dark:text-slate-700">·</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-slate-500 mt-1"><span className="text-amber-500 font-black">$</span> = financial module. Users without <strong>view</strong> see “Restricted” in place of figures.</p>
            </div>

            <div className="flex justify-end space-x-2 border-t border-slate-200/10 pt-4">
              <button onClick={() => setShowRoleEditor(false)} disabled={savingRole} className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer disabled:opacity-50">Cancel</button>
              <button onClick={handleSaveRole} disabled={savingRole} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer disabled:opacity-60">{savingRole ? 'Saving…' : (editingRole ? 'Save Changes' : 'Create Role')}</button>
            </div>
          </div>
        </div>
      )}

      {/* SESSION INACTIVITY TIMEOUT WARNING MODAL */}
      {showTimeoutWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-sm space-y-5 text-center animate-fade-in border border-slate-200/5">
            <div className="flex flex-col items-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center text-xl font-bold animate-pulse">
                ⚠
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Inactivity Warning</h3>
                <p className="text-[11px] text-slate-500 mt-1">Your session is about to expire due to inactivity.</p>
              </div>
            </div>

            <div className="bg-neo shadow-neo-inset-sm rounded-2xl p-4 border border-transparent">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Logging out in</span>
              <p className="text-2xl font-black font-mono text-blue-600 dark:text-blue-400 mt-1">
                {warningCountdown} seconds
              </p>
            </div>

            <div className="flex flex-col space-y-2">
              <button
                onClick={() => {
                  window.dispatchEvent(new Event('mousemove'));
                  setShowTimeoutWarning(false);
                }}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-3 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer transition-all font-medium"
              >
                Stay Logged In
              </button>
              <button
                onClick={handleLogout}
                className="w-full bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-red-500 font-bold text-xs py-3 rounded-xl active-shrink cursor-pointer transition-all border border-[#cbd5e1]/10 dark:border-slate-800/10 font-medium"
              >
                Logout Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOMER ACCOUNT DETAIL MODAL */}
      {showAccountModal && selectedAccountDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm no-print">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-4xl max-h-[85vh] overflow-y-auto space-y-6 animate-fade-in">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-4">
              <div>
                <h3 className="text-base font-black text-slate-800 dark:text-white">
                  Account Ledger: {selectedAccountDetails.customerName}
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Contact Info: {selectedAccountDetails.contactInfo || 'None provided'}
                </p>
              </div>
              <div className="flex items-center space-x-3">
                <button
                  onClick={() => {
                    setActiveStatementToPrint(selectedAccountDetails);
                  }}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl active-shrink shadow-md transition-all"
                >
                  Print Statement
                </button>
                <button
                  onClick={() => {
                    setShowAccountModal(false);
                    setSelectedAccountDetails(null);
                    setEditingSettings(false);
                  }}
                  className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Account Metrics Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="bg-neo shadow-neo-inset-sm p-4 rounded-2xl">
                <p className="text-[10px] text-slate-400 font-bold uppercase">Outstanding Balance</p>
                <p className={`text-xl font-black font-mono mt-1 ${Number(selectedAccountDetails.account.totalOutstanding) > 0 ? 'text-red-500' : 'text-green-600'}`}>
                  {companyCurrency} {Number(selectedAccountDetails.account.totalOutstanding).toLocaleString()}
                </p>
              </div>
              <div className="bg-neo shadow-neo-inset-sm p-4 rounded-2xl">
                <p className="text-[10px] text-slate-400 font-bold uppercase">Overdue Balance</p>
                <p className={`text-xl font-black font-mono mt-1 ${Number(selectedAccountDetails.account.totalOverdue) > 0 ? 'text-amber-500' : 'text-slate-400'}`}>
                  {companyCurrency} {Number(selectedAccountDetails.account.totalOverdue).toLocaleString()}
                </p>
              </div>
              <div className="bg-neo shadow-neo-inset-sm p-4 rounded-2xl">
                <p className="text-[10px] text-slate-400 font-bold uppercase">Credit Limit & Utilization</p>
                <p className="text-xl font-black font-mono mt-1 text-slate-800 dark:text-slate-200">
                  {Number(selectedAccountDetails.account.creditLimit) > 0 
                    ? `${companyCurrency} ${Number(selectedAccountDetails.account.creditLimit).toLocaleString()}` 
                    : 'Unlimited'}
                </p>
              </div>
            </div>

            {/* Credit Limit Gauge and Aging Summary */}
            <div className="bg-neo shadow-neo-outset p-5 rounded-2xl space-y-4">
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Credit & Aging Summary</h4>
              
              {/* Aging Breakdown Bar */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-[10px] font-bold text-slate-500">
                  <span>Aging Analysis</span>
                  <span>Total outstanding: {companyCurrency} {Number(selectedAccountDetails.account.totalOutstanding).toLocaleString()}</span>
                </div>
                <div className="h-4 w-full bg-slate-200/20 rounded-full overflow-hidden flex font-bold text-[9px] text-white text-center">
                  {Number(selectedAccountDetails.account.totalOutstanding) > 0 ? (
                    <>
                      {Number(selectedAccountDetails.account.currentBalance) > 0 && (
                        <div
                          className="bg-blue-500 flex items-center justify-center transition-all"
                          style={{ width: `${(Number(selectedAccountDetails.account.currentBalance) / Number(selectedAccountDetails.account.totalOutstanding)) * 100}%` }}
                          title={`Current: ${Number(selectedAccountDetails.account.currentBalance).toLocaleString()}`}
                        >
                          Current
                        </div>
                      )}
                      {Number(selectedAccountDetails.account.balance31_60) > 0 && (
                        <div
                          className="bg-amber-500 flex items-center justify-center transition-all"
                          style={{ width: `${(Number(selectedAccountDetails.account.balance31_60) / Number(selectedAccountDetails.account.totalOutstanding)) * 100}%` }}
                          title={`31-60d: ${Number(selectedAccountDetails.account.balance31_60).toLocaleString()}`}
                        >
                          31-60d
                        </div>
                      )}
                      {Number(selectedAccountDetails.account.balance61_90) > 0 && (
                        <div
                          className="bg-orange-500 flex items-center justify-center transition-all"
                          style={{ width: `${(Number(selectedAccountDetails.account.balance61_90) / Number(selectedAccountDetails.account.totalOutstanding)) * 100}%` }}
                          title={`61-90d: ${Number(selectedAccountDetails.account.balance61_90).toLocaleString()}`}
                        >
                          61-90d
                        </div>
                      )}
                      {Number(selectedAccountDetails.account.balanceOver90) > 0 && (
                        <div
                          className="bg-red-500 flex items-center justify-center transition-all"
                          style={{ width: `${(Number(selectedAccountDetails.account.balanceOver90) / Number(selectedAccountDetails.account.totalOutstanding)) * 100}%` }}
                          title={`90d+: ${Number(selectedAccountDetails.account.balanceOver90).toLocaleString()}`}
                        >
                          90d+
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="w-full bg-slate-300/30 text-slate-500 flex items-center justify-center font-normal">
                      No outstanding items
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2 pt-1.5 text-[10px] font-bold text-slate-500 text-center">
                  <div className="flex flex-col border-r border-slate-200/10">
                    <span className="text-blue-500">Current (0-30d)</span>
                    <span className="font-mono text-slate-700 dark:text-slate-300">{companyCurrency} {Number(selectedAccountDetails.account.currentBalance).toLocaleString()}</span>
                  </div>
                  <div className="flex flex-col border-r border-slate-200/10">
                    <span className="text-amber-500">31-60 Days</span>
                    <span className="font-mono text-slate-700 dark:text-slate-300">{companyCurrency} {Number(selectedAccountDetails.account.balance31_60).toLocaleString()}</span>
                  </div>
                  <div className="flex flex-col border-r border-slate-200/10">
                    <span className="text-orange-500">61-90 Days</span>
                    <span className="font-mono text-slate-700 dark:text-slate-300">{companyCurrency} {Number(selectedAccountDetails.account.balance61_90).toLocaleString()}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-red-500">90+ Days</span>
                    <span className="font-mono text-slate-700 dark:text-slate-300">{companyCurrency} {Number(selectedAccountDetails.account.balanceOver90).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Tabs for Details, Manual entry & settings */}
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-200/10 pb-2">
                <div className="flex space-x-3">
                  <button
                    onClick={() => setEditingSettings(false)}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${!editingSettings ? 'bg-neo shadow-neo-inset text-blue-600 dark:text-blue-400' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    Ledger Transactions
                  </button>
                  <button
                    onClick={() => setEditingSettings(true)}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${editingSettings ? 'bg-neo shadow-neo-inset text-blue-600 dark:text-blue-400' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    Account Settings
                  </button>
                </div>
                {!editingSettings && (
                  <button
                    onClick={() => setShowManualAdjustmentModal(true)}
                    className="px-3 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-green-600 dark:text-green-400 rounded-lg active-shrink transition-all"
                  >
                    Post Manual Adjustment
                  </button>
                )}
              </div>

              {/* Transactions Ledger Panel */}
              {!editingSettings ? (
                <div className="bg-neo shadow-neo-inset-sm border border-slate-200/5 rounded-2xl overflow-hidden max-h-96 overflow-y-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                        <th className="p-3">Date</th>
                        <th className="p-3">Type</th>
                        <th className="p-3">Reference</th>
                        <th className="p-3">Description</th>
                        <th className="p-3 text-right">Debit (+)</th>
                        <th className="p-3 text-right">Credit (-)</th>
                        <th className="p-3 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs divide-y divide-slate-200/10">
                      {selectedAccountDetails.transactions.map((tx: any) => {
                        const amount = Number(tx.amount);
                        const isDebit = amount > 0;
                        const isCredit = amount < 0;

                        return (
                          <tr key={tx.id} className="hover:bg-slate-200/5 dark:hover:bg-slate-800/5">
                            <td className="p-3 font-mono text-[10px]">
                              {new Date(tx.createdAt).toLocaleDateString()}
                            </td>
                            <td className="p-3">
                              <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                                tx.transactionType === 'invoice' ? 'bg-blue-500/10 text-blue-500 border border-blue-500/20' :
                                tx.transactionType === 'payment' ? 'bg-green-500/10 text-green-500 border border-green-500/20' :
                                tx.transactionType === 'credit_memo' ? 'bg-indigo-500/10 text-indigo-500 border border-indigo-500/20' :
                                tx.transactionType === 'booking_deposit' ? 'bg-green-500/10 text-green-500 border border-green-500/20' :
                                tx.transactionType === 'late_fee' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' :
                                'bg-slate-500/10 text-slate-500 border border-slate-500/20'
                              }`}>
                                {tx.transactionType.replace('_', ' ')}
                              </span>
                            </td>
                            <td className="p-3 font-mono text-[10px]">{tx.referenceNumber || '—'}</td>
                            <td className="p-3 text-slate-600 dark:text-slate-300 font-medium">{tx.description}</td>
                            <td className="p-3 text-right font-mono text-red-500 font-bold">
                              {isDebit ? `${companyCurrency} ${amount.toLocaleString()}` : ''}
                            </td>
                            <td className="p-3 text-right font-mono text-green-600 font-bold">
                              {isCredit ? `${companyCurrency} ${Math.abs(amount).toLocaleString()}` : ''}
                            </td>
                            <td className="p-3 text-right font-mono font-bold text-slate-700 dark:text-slate-200">
                              {companyCurrency} {Number(tx.balanceAfterTransaction).toLocaleString()}
                            </td>
                          </tr>
                        );
                      })}
                      {selectedAccountDetails.transactions.length === 0 && (
                        <tr>
                          <td colSpan={7} className="p-8 text-center text-slate-400 font-medium">
                            No ledger transactions recorded yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                /* Edit Account Settings Panel */
                <div className="bg-neo shadow-neo-inset-sm border border-[#cbd5e1]/10 dark:border-slate-800/10 rounded-2xl p-5 space-y-4">
                  <h4 className="text-xs font-black text-slate-700 dark:text-slate-200 uppercase tracking-wider">Account Configurations</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Credit Limit ({companyCurrency})</label>
                      <input
                        type="number"
                        placeholder="0 = Unlimited Credit Limit"
                        value={editCreditLimit}
                        onChange={e => setEditCreditLimit(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Payment Terms (Net Days)</label>
                      <input
                        type="number"
                        placeholder="e.g. 30 for Net 30"
                        value={editPaymentTerms}
                        onChange={e => setEditPaymentTerms(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end space-x-3 pt-2">
                    <button
                      onClick={() => setEditingSettings(false)}
                      className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink transition-all"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleUpdateAccountSettings}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl active-shrink shadow-md transition-all"
                    >
                      Save Configuration
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* POST MANUAL TRANSACTION MODAL */}
      {showManualAdjustmentModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm no-print">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-5 animate-fade-in">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Post Account Adjustment</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">Applies a debit or credit directly to the customer ledger</p>
              </div>
              <button
                onClick={() => setShowManualAdjustmentModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Adjustment Type</label>
                <select
                  value={adjType}
                  onChange={e => setAdjType(e.target.value as any)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                >
                  <option value="adjustment">Debit Adjustment (+ Balance)</option>
                  <option value="invoice">Manual Debit Invoice (+ Balance)</option>
                  <option value="late_fee">Manual Late Fee (+ Balance)</option>
                  <option value="damage_fee">Manual Damage/Loss Fee (+ Balance)</option>
                  <option value="payment">Manual Cash Payment Received (- Balance)</option>
                  <option value="credit_memo">Credit Memo (- Balance)</option>
                  <option value="refund">Adjustment Refund Issued (- Balance)</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Amount ({companyCurrency}) *</label>
                <input
                  type="number"
                  placeholder="e.g. 50000"
                  value={adjAmount}
                  onChange={e => setAdjAmount(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Description *</label>
                <input
                  type="text"
                  placeholder="Reason for adjustment…"
                  value={adjDescription}
                  onChange={e => setAdjDescription(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Reference #</label>
                  <input
                    type="text"
                    placeholder="e.g. ADJ-901"
                    value={adjReference}
                    onChange={e => setAdjReference(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Due Date (Debits only)</label>
                  <input
                    type="date"
                    value={adjDueDate}
                    onChange={e => setAdjDueDate(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono cursor-pointer"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-3 pt-2">
              <button
                onClick={() => setShowManualAdjustmentModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitManualTransaction}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-bold text-xs rounded-xl active-shrink shadow-md transition-all"
              >
                Post to Ledger
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOMER ACCOUNT STATEMENT PRINT PREVIEW OVERLAY */}
      {activeStatementToPrint && (
        <div className="fixed inset-0 z-[100] flex flex-col bg-white dark:bg-slate-900 overflow-y-auto p-8 font-sans text-slate-800 dark:text-slate-100">
          {/* Action buttons (hidden during print) */}
          <div className="flex items-center justify-between pb-6 border-b border-slate-200/20 max-w-4xl mx-auto w-full no-print">
            <h3 className="text-sm font-black uppercase text-slate-500">Account Statement Print Preview</h3>
            <div className="flex space-x-3">
              <button
                onClick={() => window.print()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-lg active-shrink cursor-pointer transition-all"
              >
                🖨 Print Statement
              </button>
              <button
                onClick={() => setActiveStatementToPrint(null)}
                className="px-4 py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-slate-700 dark:text-slate-300 font-bold text-xs rounded-xl active-shrink cursor-pointer transition-all border border-slate-200/10"
              >
                Close Preview
              </button>
            </div>
          </div>

          {/* Statement template layout */}
          <div className="flex-1 max-w-4xl mx-auto w-full py-8 space-y-8 select-text">
            {/* Header info */}
            <div className="flex justify-between items-start border-b border-slate-300 dark:border-slate-800 pb-6">
              <div className="space-y-1">
                <div className="text-2xl font-black text-blue-600">{activeCompany.name}</div>
                <p className="text-xs text-slate-500">Corporate Rental & Assets Engine</p>
                <p className="text-xs text-slate-500">Locale: {currentUser?.company?.country || 'UG'}</p>
              </div>
              <div className="text-right space-y-1">
                <div className="text-lg font-black uppercase tracking-widest text-slate-500">Account Statement</div>
                <p className="text-xs text-slate-500 font-mono">Date Generated: {new Date().toLocaleDateString()}</p>
                <p className="text-xs text-slate-500 font-mono">Statement Period: Lifetime Ledger</p>
              </div>
            </div>

            {/* Billing Address Details */}
            <div className="grid grid-cols-2 gap-6 text-xs">
              <div>
                <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider">Statement Issued To</p>
                <div className="font-bold mt-1 text-slate-900 dark:text-slate-100">{activeStatementToPrint.customerName}</div>
                <p className="mt-1 text-slate-500 font-medium">{activeStatementToPrint.contactInfo || 'No contact details available'}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider">Account Terms Summary</p>
                <div className="grid grid-cols-2 gap-y-1 mt-1 text-slate-500">
                  <span>Base Currency:</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">{companyCurrency}</span>
                  <span>Payment Terms:</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">Net {activeStatementToPrint.account.paymentTermsDays} Days</span>
                  <span>Credit Limit:</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    {Number(activeStatementToPrint.account.creditLimit) > 0 
                      ? `${companyCurrency} ${Number(activeStatementToPrint.account.creditLimit).toLocaleString()}` 
                      : 'No Limit'}
                  </span>
                </div>
              </div>
            </div>

            {/* Financial Summary */}
            <div className="grid grid-cols-3 gap-4 bg-slate-100/50 dark:bg-slate-800/30 p-4 rounded-xl text-center border border-slate-200/10">
              <div>
                <div className="text-[10px] text-slate-400 uppercase font-black">Outstanding Balance</div>
                <div className={`text-base font-black font-mono mt-1 ${Number(activeStatementToPrint.account.totalOutstanding) > 0 ? 'text-red-500' : 'text-green-600'}`}>
                  {companyCurrency} {Number(activeStatementToPrint.account.totalOutstanding).toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400 uppercase font-black">Overdue Balance</div>
                <div className={`text-base font-black font-mono mt-1 ${Number(activeStatementToPrint.account.totalOverdue) > 0 ? 'text-amber-500' : 'text-slate-400'}`}>
                  {companyCurrency} {Number(activeStatementToPrint.account.totalOverdue).toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400 uppercase font-black">Last Payment Received</div>
                <div className="text-base font-black font-mono mt-1 text-slate-800 dark:text-slate-200">
                  {activeStatementToPrint.account.lastPaymentDate 
                    ? `${companyCurrency} ${Number(activeStatementToPrint.account.lastPaymentAmount).toLocaleString()}` 
                    : '—'}
                </div>
              </div>
            </div>

            {/* Aging breakdown table */}
            <div className="space-y-2">
              <h4 className="text-[10px] text-slate-400 uppercase font-black tracking-wider">Balances Aging Bucket Analysis</h4>
              <div className="grid grid-cols-4 gap-4 bg-slate-50 dark:bg-slate-800/10 p-3 rounded-lg border border-slate-200/10 text-center text-xs font-medium">
                <div className="flex flex-col border-r border-slate-200/10">
                  <span className="text-blue-500 text-[10px] font-bold">Current (0-30d)</span>
                  <span className="font-mono mt-0.5 text-slate-700 dark:text-slate-300 font-bold">{companyCurrency} {Number(activeStatementToPrint.account.currentBalance).toLocaleString()}</span>
                </div>
                <div className="flex flex-col border-r border-slate-200/10">
                  <span className="text-amber-500 text-[10px] font-bold">31-60 Days</span>
                  <span className="font-mono mt-0.5 text-slate-700 dark:text-slate-300 font-bold">{companyCurrency} {Number(activeStatementToPrint.account.balance31_60).toLocaleString()}</span>
                </div>
                <div className="flex flex-col border-r border-slate-200/10">
                  <span className="text-orange-500 text-[10px] font-bold">61-90 Days</span>
                  <span className="font-mono mt-0.5 text-slate-700 dark:text-slate-300 font-bold">{companyCurrency} {Number(activeStatementToPrint.account.balance61_90).toLocaleString()}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-red-500 text-[10px] font-bold">90+ Days</span>
                  <span className="font-mono mt-0.5 text-slate-700 dark:text-slate-300 font-bold">{companyCurrency} {Number(activeStatementToPrint.account.balanceOver90).toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* Itemized transaction list */}
            <div className="space-y-3">
              <h4 className="text-[10px] text-slate-400 uppercase font-black tracking-wider">Itemized Transactions Details</h4>
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-300 text-slate-400 font-black uppercase text-[9px]">
                    <th className="py-2">Date</th>
                    <th className="py-2">Type</th>
                    <th className="py-2">Reference</th>
                    <th className="py-2">Description</th>
                    <th className="py-2 text-right">Debit (+)</th>
                    <th className="py-2 text-right">Credit (-)</th>
                    <th className="py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {activeStatementToPrint.transactions.map((tx: any) => {
                    const amount = Number(tx.amount);
                    return (
                      <tr key={tx.id} className="text-slate-700 dark:text-slate-300">
                        <td className="py-2.5 font-mono text-[10px]">{new Date(tx.createdAt).toLocaleDateString()}</td>
                        <td className="py-2.5 uppercase font-bold text-[9px]">{tx.transactionType.replace('_', ' ')}</td>
                        <td className="py-2.5 font-mono text-[10px]">{tx.referenceNumber || '—'}</td>
                        <td className="py-2.5 text-slate-500 font-medium">{tx.description}</td>
                        <td className="py-2.5 text-right font-mono font-bold text-red-500">
                          {amount > 0 ? `${companyCurrency} ${amount.toLocaleString()}` : ''}
                        </td>
                        <td className="py-2.5 text-right font-mono font-bold text-green-600">
                          {amount < 0 ? `${companyCurrency} ${Math.abs(amount).toLocaleString()}` : ''}
                        </td>
                        <td className="py-2.5 text-right font-mono font-black text-slate-800 dark:text-slate-200">
                          {companyCurrency} {Number(tx.balanceAfterTransaction).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Corporate footer details */}
            <div className="border-t border-slate-300 dark:border-slate-800 pt-6 text-[10px] text-slate-400 text-center">
              <p>For any queries regarding this account statement, please contact the finance division of {activeCompany.name}.</p>
              <p className="mt-1">Generated dynamically using YourHires Rebuild Core accounting ledger database modules.</p>
            </div>
          </div>
        </div>
      )}

      {/* ASSET MAINTENANCE MODAL */}
      {showMaintenanceModal && selectedAssetForMaintenance && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-4xl max-h-[85vh] overflow-y-auto space-y-6 animate-fade-in">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-4">
              <div>
                <h3 className="text-base font-black text-slate-800 dark:text-white">
                  Asset Maintenance Log: {selectedAssetForMaintenance.name}
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Serial Number: {selectedAssetForMaintenance.serialNumber} | Current Status: <strong className="text-amber-500">{selectedAssetForMaintenance.status}</strong>
                </p>
              </div>
              <button
                onClick={() => {
                  setShowMaintenanceModal(false);
                  setSelectedAssetForMaintenance(null);
                }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Schedule Form */}
              <div className="lg:col-span-2 bg-neo shadow-neo-inset-sm p-4 rounded-2xl space-y-4 h-fit">
                <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-wider">Schedule Servicing</h4>
                <div className="space-y-3 text-xs">
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500">Event Title *</label>
                    <input
                      type="text"
                      placeholder="e.g. Annual Calibration"
                      value={maintTitle}
                      onChange={e => setMaintTitle(e.target.value)}
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500">Description</label>
                    <textarea
                      placeholder="Details of repair work…"
                      value={maintDescription}
                      onChange={e => setMaintDescription(e.target.value)}
                      rows={2}
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none resize-none"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500">Start Time *</label>
                      <input
                        type="datetime-local"
                        value={maintStartTime}
                        onChange={e => setMaintStartTime(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-[10px] text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500">End Time *</label>
                      <input
                        type="datetime-local"
                        value={maintEndTime}
                        onChange={e => setMaintEndTime(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-[10px] text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500">Initial Status</label>
                      <select
                        value={maintStatus}
                        onChange={e => setMaintStatus(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                      >
                        <option value="Scheduled">Scheduled</option>
                        <option value="in_progress">In Progress</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500">Est. Cost (UGX)</label>
                      <input
                        type="number"
                        placeholder="0"
                        value={maintCost}
                        onChange={e => setMaintCost(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500">Notes</label>
                    <input
                      type="text"
                      placeholder="e.g. Send to technician"
                      value={maintNotes}
                      onChange={e => setMaintNotes(e.target.value)}
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                  </div>
                  <button
                    onClick={handleScheduleMaintenance}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-md active-shrink transition-all mt-2"
                  >
                    Log Servicing Event
                  </button>
                </div>
              </div>

              {/* Maintenance Logs List */}
              <div className="lg:col-span-3 bg-neo shadow-neo-outset p-4 rounded-2xl space-y-4">
                <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-wider">Historical Logs</h4>
                <div className="space-y-3 overflow-y-auto max-h-[50vh] pr-1">
                  {maintenanceEvents.map(evt => (
                    <div key={evt.id} className="bg-neo shadow-neo-inset-sm p-4 rounded-xl border border-slate-200/5 text-xs space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800 dark:text-slate-200">{evt.title}</span>
                        <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                          evt.status === 'Completed' ? 'bg-green-500/10 text-green-600 border border-green-500/20' :
                          evt.status === 'in_progress' ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20' :
                          'bg-slate-500/10 text-slate-600 border border-slate-500/20'
                        }`}>
                          {evt.status}
                        </span>
                      </div>
                      <p className="text-slate-500">{evt.description || 'No description provided.'}</p>
                      <div className="grid grid-cols-2 gap-y-1 text-[10px] text-slate-400 font-medium">
                        <span>Start: {new Date(evt.startTime).toLocaleString()}</span>
                        <span>End: {new Date(evt.endTime).toLocaleString()}</span>
                        <span>Cost: <strong className="text-slate-600 dark:text-slate-300 font-mono">UGX {Number(evt.cost).toLocaleString()}</strong></span>
                        {evt.notes && <span>Notes: {evt.notes}</span>}
                      </div>
                      {evt.status !== 'Completed' && evt.status !== 'Cancelled' && (
                        <div className="flex justify-end pt-1">
                          <button
                            onClick={() => handleCompleteMaintenance(evt.id)}
                            className="px-3 py-1 bg-green-600 hover:bg-green-700 text-[10px] text-white font-bold rounded-lg active-shrink transition-all"
                          >
                            Mark Completed
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {maintenanceEvents.length === 0 && (
                    <p className="text-slate-400 text-center py-10 font-medium">No servicing events logged for this asset.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EVENT DETAILS MANAGEMENT DRAWER (COCKPIT) */}
      {showFunctionDrawer && selectedFunctionEvent && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs no-print">
          <div className="bg-neo shadow-neo-outset w-full max-w-3xl h-full flex flex-col p-6 overflow-y-auto space-y-6 animate-slide-left">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-4 shrink-0">
              <div>
                <span className="text-[10px] text-blue-600 dark:text-blue-400 font-bold uppercase tracking-wider">Event Cockpit View</span>
                <h3 className="text-base font-black text-slate-800 dark:text-white mt-0.5">{selectedFunctionEvent.name}</h3>
                <p className="text-[11px] text-slate-500 font-medium">
                  {selectedFunctionEvent.date} @ {selectedFunctionEvent.time} | Client: {selectedFunctionEvent.clientName} ({selectedFunctionEvent.clientContact})
                </p>
              </div>
              <div className="flex items-center space-x-2">
                {selectedFunctionEvent.status !== 'Completed' && selectedFunctionEvent.status !== 'Cancelled' && (
                  <button
                    onClick={() => setShowCompleteFunctionModal(true)}
                    className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white text-[11px] font-bold rounded-xl flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                  >
                    <CheckCircle2 size={14} />
                    <span>Mark Complete</span>
                  </button>
                )}
                <button
                  onClick={() => { setSignatureType('function'); setShowSignatureModal(true); }}
                  className="px-3 py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset text-[11px] font-bold text-slate-600 dark:text-slate-400 rounded-xl flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                >
                  <span>✍️</span>
                  <span>Capture Signature</span>
                </button>
                <button
                  onClick={handlePrintBEO}
                  className="px-3 py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset text-[11px] font-bold text-blue-600 dark:text-blue-400 rounded-xl flex items-center space-x-1.5 active-shrink transition-all cursor-pointer"
                >
                  <span>📋</span>
                  <span>Print BEO Sheet</span>
                </button>
                <button
                  onClick={() => {
                    setShowFunctionDrawer(false);
                    setSelectedFunctionEvent(null);
                  }}
                  className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {selectedFunctionEvent.status === 'Completed' && (
              <div className="flex items-center space-x-2 bg-green-500/10 border border-green-500/20 rounded-xl p-3 text-[11px] text-green-700 dark:text-green-400 shrink-0">
                <CheckCircle2 size={14} className="shrink-0" />
                <span>Completed {selectedFunctionEvent.completedAt ? `on ${new Date(selectedFunctionEvent.completedAt).toLocaleDateString()}` : ''}{selectedFunctionEvent.completionNotes ? ` — ${selectedFunctionEvent.completionNotes}` : ''}</span>
              </div>
            )}

            {/* Sub-tabs Selector */}
            <div className="flex border-b border-slate-200/10 pb-2 space-x-2 shrink-0">
              {([
                { id: 'staffing', label: 'Staff assignments' },
                { id: 'equipment', label: 'Equipment reservations' },
                { id: 'checklist', label: 'Event checklist' },
                { id: 'issues', label: 'Incidents / Issues' },
                { id: 'financials', label: 'Financials' },
                { id: 'timeline', label: 'Activity timeline' }
              ] as const).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveFunctionTab(tab.id)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                    activeFunctionTab === tab.id 
                      ? 'bg-neo shadow-neo-inset text-blue-600 dark:text-blue-400' 
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tabs Content Panels */}
            <div className="flex-1 overflow-y-auto pr-1">
              
              {/* TAB 1: STAFFING */}
              {activeFunctionTab === 'staffing' && (
                <div className="space-y-5">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Assigned Employees</h4>
                    <button
                      onClick={() => {
                        setAssignEventId(selectedFunctionEvent.id);
                        setShowAssignStaffModal(true);
                      }}
                      className="px-3 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all cursor-pointer"
                    >
                      Assign Staff Member
                    </button>
                  </div>

                  <div className="bg-neo shadow-neo-inset-sm border border-slate-200/5 rounded-2xl overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                          <th className="p-3">Staff Name</th>
                          <th className="p-3">Assigned Role</th>
                          <th className="p-3">Status</th>
                          <th className="p-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/10">
                        {(selectedFunctionEvent.functionAssignments || []).map((asn: any) => (
                          <tr key={asn.id} className="hover:bg-slate-200/5">
                            <td className="p-3 font-bold text-slate-700 dark:text-slate-300">{asn.employee?.name}</td>
                            <td className="p-3 font-medium text-slate-500">{asn.role?.name}</td>
                            <td className="p-3">
                              <span className="text-[10px] font-bold text-slate-600">{asn.status}</span>
                            </td>
                            <td className="p-3 text-right">
                              <button
                                onClick={async () => {
                                  if (!confirm('Remove this staff assignment?')) return;
                                  try {
                                    const headers = { 'x-company-id': selectedCompanyId.toString() };
                                    const res = await fetch(`${API_URL}/api/function-assignments/${asn.id}`, { method: 'DELETE', headers });
                                    if (!res.ok) throw new Error((await res.json()).error);
                                    alert('Staff member removed.');
                                    fetchFunctionDetails(selectedFunctionEvent);
                                    await fetchAllData();
                                  } catch (err: any) { alert(err.message); }
                                }}
                                className="text-red-500 hover:text-red-700 font-bold"
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                        {(selectedFunctionEvent.functionAssignments || []).length === 0 && (
                          <tr>
                            <td colSpan={4} className="p-6 text-center text-slate-400 font-medium">
                              No staff members assigned to this event yet.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* TAB 2: EQUIPMENT RESERVATIONS */}
              {activeFunctionTab === 'equipment' && (
                <div className="space-y-6">
                  
                  {/* Reservation Form */}
                  <div className="bg-neo shadow-neo-inset-sm p-4 rounded-2xl space-y-4">
                    <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-wider">Reserve Equipment & Fleet Assets</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500 block">Inventory Type</label>
                        <select
                          value={reserveType}
                          onChange={e => setReserveType(e.target.value as any)}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                        >
                          <option value="item">Standard Inventory Item (Bulk Quantity)</option>
                          <option value="asset">Serialized Fleet Asset (Unique ID)</option>
                          <option value="consumable">Consumable Non-Serialized (Outflow/Sale)</option>
                        </select>
                      </div>

                      {reserveType === 'item' ? (
                        <div className="space-y-1">
                          <label className="text-[10px] uppercase font-bold text-slate-500 block">Select Item</label>
                          <select
                            value={reserveItemId}
                            onChange={e => setReserveItemId(e.target.value)}
                            className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                          >
                            <option value="">-- Choose Stock Item --</option>
                            {items.map(it => (
                              <option key={it.id} value={it.id}>{it.name} (Stock: {it.currentStock})</option>
                            ))}
                          </select>
                        </div>
                      ) : reserveType === 'asset' ? (
                        <div className="space-y-1">
                          <label className="text-[10px] uppercase font-bold text-slate-500 block">Select Serialized Asset</label>
                          <select
                            value={reserveAssetId}
                            onChange={e => setReserveAssetId(e.target.value)}
                            className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                          >
                            <option value="">-- Choose Asset Unit --</option>
                            {assets.filter(a => a.status === 'Available').map(a => (
                              <option key={a.id} value={a.id}>{a.name} ({a.serialNumber})</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <>
                          <div className="space-y-1">
                            <label className="text-[10px] uppercase font-bold text-slate-500 block">Select Consumable</label>
                            <select
                              value={reserveConsumableId}
                              onChange={e => {
                                setReserveConsumableId(e.target.value);
                                const cons = consumables.find(c => c.id === parseInt(e.target.value));
                                if (cons) {
                                  setReserveUomId(cons.pieceUnitId?.toString() || cons.unitOfMeasureId?.toString() || '');
                                }
                              }}
                              className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                            >
                              <option value="">-- Choose Consumable --</option>
                              {consumables.map(c => (
                                <option key={c.id} value={c.id}>{c.name} (Stock: {c.stockQty})</option>
                              ))}
                            </select>
                          </div>

                          {/* UOM Selector if the consumable is selected */}
                          {(() => {
                            const selectedCons = consumables.find(c => c.id === parseInt(reserveConsumableId));
                            if (!selectedCons) return null;
                            return (
                              <div className="space-y-1 col-span-1 md:col-span-2">
                                <label className="text-[10px] uppercase font-bold text-slate-500 block">Select Unit of Measure</label>
                                <select
                                  value={reserveUomId}
                                  onChange={e => setReserveUomId(e.target.value)}
                                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                                >
                                  {selectedCons.isMultiUnit ? (
                                    <>
                                      <option value={selectedCons.packageUnitId || ''}>{selectedCons.packageUnit?.name || 'Package Unit'} ({selectedCons.packageUnit?.abbreviation || 'Pkg'})</option>
                                      <option value={selectedCons.pieceUnitId || ''}>{selectedCons.pieceUnit?.name || 'Piece Unit'} ({selectedCons.pieceUnit?.abbreviation || 'Pcs'})</option>
                                    </>
                                  ) : (
                                    <option value={selectedCons.unitOfMeasureId || ''}>{selectedCons.unitOfMeasure?.name || 'Base Unit'} ({selectedCons.unitOfMeasure?.abbreviation || 'unit'})</option>
                                  )}
                                </select>
                              </div>
                            );
                          })()}
                        </>
                      )}

                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500 block">Quantity (Items only)</label>
                        <input
                          type="number"
                          value={reserveQuantity}
                          disabled={reserveType === 'asset'}
                          onChange={e => setReserveQuantity(e.target.value)}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono disabled:opacity-50"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500 block">Notes / Handover Instructions</label>
                        <input
                          type="text"
                          placeholder="Special instructions…"
                          value={reserveNotes}
                          onChange={e => setReserveNotes(e.target.value)}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={handleReserveItem}
                        className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl active-shrink transition-all shadow-md"
                      >
                        Add to Event Equipment list
                      </button>
                    </div>
                  </div>

                  {/* Reservations Table */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Reserved Equipment List</h4>
                    <div className="bg-neo shadow-neo-inset-sm border border-slate-200/5 rounded-2xl overflow-hidden">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                            <th className="p-3">Item/Asset Name</th>
                            <th className="p-3">Type</th>
                            <th className="p-3 text-center">Qty</th>
                            <th className="p-3 text-center">Status</th>
                            <th className="p-3 text-right">Operations</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200/10">
                          {functionItems.map(assign => {
                            const name = assign.item?.name || assign.asset?.name || assign.consumable?.name || '';
                            const detail = assign.itemType === 'asset' 
                              ? `(${assign.asset?.serialNumber})` 
                              : assign.itemType === 'consumable' 
                              ? `(${assign.unitOfMeasure?.abbreviation || 'units'})` 
                              : '';

                            return (
                              <tr key={assign.id} className="hover:bg-slate-200/5">
                                <td className="p-3 font-bold text-slate-700 dark:text-slate-300">
                                  {name} <span className="text-[10px] text-slate-400 font-normal">{detail}</span>
                                </td>
                                <td className="p-3 capitalize text-slate-500 font-medium">{assign.itemType}</td>
                                <td className="p-3 text-center font-mono font-bold">{assign.quantity}</td>
                                <td className="p-3 text-center">
                                  <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                                    assign.status === 'returned' ? 'bg-green-500/10 text-green-600 border border-green-500/20' :
                                    assign.status === 'dispatched' ? 'bg-blue-500/10 text-blue-600 border border-blue-500/20' :
                                    'bg-amber-500/10 text-amber-600 border border-amber-500/20'
                                  }`}>
                                    {assign.status}
                                  </span>
                                </td>
                                <td className="p-3 text-right">
                                  <div className="flex items-center justify-end space-x-1.5">
                                    {assign.status === 'booked' && (
                                      <>
                                        <button
                                          onClick={() => handleDispatchReservation(assign.id)}
                                          className="px-2 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[9px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink"
                                        >
                                          Dispatch
                                        </button>
                                        <button
                                          onClick={() => handleCancelReservation(assign.id)}
                                          className="px-2 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[9px] font-bold text-red-500 rounded-lg active-shrink"
                                        >
                                          Cancel
                                        </button>
                                      </>
                                    )}
                                    {assign.status === 'dispatched' && (
                                      <button
                                        onClick={() => handleReturnReservation(assign.id)}
                                        className="px-2 py-1 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[9px] font-bold text-green-600 dark:text-green-400 rounded-lg active-shrink"
                                      >
                                        Return Stock
                                      </button>
                                    )}
                                    {assign.status === 'returned' && (
                                      <span className="text-[10px] text-slate-400 italic">Completed</span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                          {functionItems.length === 0 && (
                            <tr>
                              <td colSpan={5} className="p-6 text-center text-slate-400 font-medium">
                                No equipment assigned to this event.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: CHECKLIST */}
              {activeFunctionTab === 'checklist' && (
                <div className="space-y-5">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Pre-Event Checklists</h4>
                  
                  {/* Add item */}
                  <div className="flex items-center space-x-3">
                    <input
                      type="text"
                      placeholder="Add task detail (e.g. Confirm audio technician setup)…"
                      value={newChecklistText}
                      onChange={e => setNewChecklistText(e.target.value)}
                      className="flex-1 bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                    <select
                      value={checklistAssigneeId}
                      onChange={e => setChecklistAssigneeId(e.target.value)}
                      className="bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer w-44 shrink-0"
                    >
                      <option value="">-- Assign Staff --</option>
                      {(selectedFunctionEvent.functionAssignments || []).map((asn: any) => (
                        <option key={asn.employee?.id} value={asn.employee?.id}>
                          {asn.employee?.name}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleCreateChecklistItem}
                      className="px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl active-shrink shadow-md transition-all shrink-0"
                    >
                      Add Task
                    </button>
                  </div>

                  {/* Tasks List */}
                  <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                    {functionChecklist.map(item => (
                      <div
                        key={item.id}
                        onClick={() => handleToggleChecklistItem(item.id, item.isCompleted)}
                        className="bg-neo shadow-neo-outset hover:shadow-neo-inset-sm p-3.5 rounded-xl flex items-center justify-between border border-slate-200/5 cursor-pointer active-shrink transition-all text-xs"
                      >
                        <div className="flex items-center space-x-3">
                          <input
                            type="checkbox"
                            checked={item.isCompleted}
                            readOnly
                            className="w-4 h-4 rounded border-none bg-neo shadow-neo-inset-sm cursor-pointer accent-blue-600"
                          />
                          <span className={`font-medium ${item.isCompleted ? 'line-through text-slate-400' : 'text-slate-700 dark:text-slate-200'}`}>
                            {item.itemText}
                          </span>
                          {item.assignedEmployee && (
                            <span className="text-[10px] bg-blue-600/10 text-blue-600 dark:text-blue-400 font-bold px-2 py-0.5 rounded-lg border border-blue-500/10 inline-flex items-center space-x-1 shrink-0 ml-2">
                              <span>👤</span>
                              <span>{item.assignedEmployee.name}</span>
                            </span>
                          )}
                        </div>
                        {item.isCompleted && item.completedAt && (
                          <span className="text-[9px] text-slate-400 font-mono">
                            Done: {new Date(item.completedAt).toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                    ))}
                    {functionChecklist.length === 0 && (
                      <p className="text-slate-400 text-center py-10 font-medium">No checklist tasks recorded for this event.</p>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 4: ISSUES LOGS */}
              {activeFunctionTab === 'issues' && (
                <div className="space-y-6">
                  
                  {/* Report Issue Form */}
                  <div className="bg-neo shadow-neo-inset-sm p-4 rounded-2xl space-y-4 text-xs">
                    <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-wider">Report Operational Incident</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div className="space-y-1 md:col-span-2">
                        <label className="text-[10px] uppercase font-bold text-slate-500">Incident Title *</label>
                        <input
                          type="text"
                          placeholder="e.g. Audio cables damaged on site"
                          value={newIssueTitle}
                          onChange={e => setNewIssueTitle(e.target.value)}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500">Severity</label>
                        <select
                          value={newIssueSeverity}
                          onChange={e => setNewIssueSeverity(e.target.value as any)}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                        >
                          <option value="Low">Low</option>
                          <option value="Medium">Medium</option>
                          <option value="High">High</option>
                          <option value="Critical">Critical</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-slate-500">Problem Description *</label>
                      <textarea
                        placeholder="Detail the issue..."
                        value={newIssueDescription}
                        onChange={e => setNewIssueDescription(e.target.value)}
                        rows={2}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none resize-none"
                      />
                    </div>
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={handleCreateFunctionIssue}
                        className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl active-shrink transition-all shadow-md"
                      >
                        File Incident Report
                      </button>
                    </div>
                  </div>

                  {/* Issues List */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Reported Incidents</h4>
                    <div className="space-y-3 overflow-y-auto max-h-[40vh] pr-1">
                      {functionIssues.map(issue => (
                        <div key={issue.id} className="bg-neo shadow-neo-outset p-4 rounded-xl border border-slate-200/5 text-xs space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-2">
                              <span className="font-bold text-slate-800 dark:text-slate-200">{issue.title}</span>
                              <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                                issue.severity === 'Critical' ? 'bg-red-500/10 text-red-500 border border-red-500/20' :
                                issue.severity === 'High' ? 'bg-orange-500/10 text-orange-500 border border-orange-500/20' :
                                issue.severity === 'Medium' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' :
                                'bg-blue-500/10 text-blue-500 border border-blue-500/20'
                              }`}>
                                {issue.severity}
                              </span>
                            </div>
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                              issue.status === 'Resolved' ? 'bg-green-500/10 text-green-600' : 'bg-slate-500/10 text-slate-500'
                            }`}>
                              {issue.status}
                            </span>
                          </div>
                          <p className="text-slate-500 font-medium">{issue.description}</p>
                          {issue.resolutionNotes && (
                            <div className="bg-neo shadow-neo-inset-sm p-2.5 rounded-lg border border-slate-200/5 text-[11px] text-slate-600 dark:text-slate-400">
                              <strong>Resolution notes:</strong> {issue.resolutionNotes}
                            </div>
                          )}
                          {issue.status !== 'Resolved' && issue.status !== 'Closed' && (
                            <div className="flex justify-end pt-1">
                              <button
                                onClick={() => handleUpdateIssueStatus(issue.id, 'Resolved')}
                                className="px-2.5 py-1 bg-green-600 hover:bg-green-700 text-[10px] text-white font-bold rounded-lg active-shrink transition-all"
                              >
                                Mark Resolved
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                      {functionIssues.length === 0 && (
                        <p className="text-slate-400 text-center py-10 font-medium">No incidents or issues filed for this event.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB: FINANCIALS */}
              {activeFunctionTab === 'financials' && (() => {
                const totalRevenue = Number(selectedFunctionEvent.totalRevenue || 0);
                const totalExpenses = Number(selectedFunctionEvent.totalExpenses || 0);
                const netProfit = totalRevenue - totalExpenses;
                return (
                  <div className="space-y-6">
                    <div>
                      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Function Profit &amp; Loss</h4>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-neo shadow-neo-outset p-4 rounded-2xl">
                          <p className="text-[9px] uppercase font-black text-slate-500">Revenue</p>
                          <p className="text-sm font-black font-mono text-green-600 dark:text-green-400">{companyCurrency} {totalRevenue.toLocaleString()}</p>
                          {selectedFunctionEvent.revenuePaid && <p className="text-[9px] text-green-500 mt-0.5">✓ Paid</p>}
                        </div>
                        <div className="bg-neo shadow-neo-outset p-4 rounded-2xl">
                          <p className="text-[9px] uppercase font-black text-slate-500">Expenses</p>
                          <p className="text-sm font-black font-mono text-red-500">{companyCurrency} {totalExpenses.toLocaleString()}</p>
                        </div>
                        <div className="bg-neo shadow-neo-outset p-4 rounded-2xl">
                          <p className="text-[9px] uppercase font-black text-slate-500">Net Profit</p>
                          <p className={`text-sm font-black font-mono ${netProfit >= 0 ? 'text-slate-800 dark:text-slate-200' : 'text-red-500'}`}>{companyCurrency} {netProfit.toLocaleString()}</p>
                        </div>
                      </div>
                    </div>

                    {/* Record revenue */}
                    <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-4 rounded-2xl space-y-3">
                      <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Record Revenue</h4>
                      <div className="grid grid-cols-4 gap-2">
                        <input type="number" placeholder="Amount" value={newRevAmount} onChange={e => setNewRevAmount(e.target.value)}
                          className="bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                        <select value={newRevMethod} onChange={e => setNewRevMethod(e.target.value)}
                          className="bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer">
                          <option value="cash">Cash</option>
                          <option value="bank_transfer">Bank Transfer</option>
                          <option value="mobile_money">Mobile Money</option>
                          <option value="check">Check</option>
                          <option value="other">Other</option>
                        </select>
                        <input type="text" placeholder="Reference #" value={newRevRef} onChange={e => setNewRevRef(e.target.value)}
                          className="bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                        <button onClick={handleRecordFunctionRevenue}
                          className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer">Record</button>
                      </div>
                      <input type="text" placeholder="Notes (optional)" value={newRevNotes} onChange={e => setNewRevNotes(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                    </div>

                    {/* Add + list expenses */}
                    <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-4 rounded-2xl space-y-3">
                      <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Function Expenses</h4>
                      <div className="grid grid-cols-5 gap-2">
                        <select value={fxExpType} onChange={e => setFxExpType(e.target.value)}
                          className="bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer">
                          <option value="transportation">Transportation</option>
                          <option value="setup">Setup Fees</option>
                          <option value="labor">Labor</option>
                          <option value="equipment">Equipment Rental</option>
                          <option value="supplies">Supplies</option>
                          <option value="other">Other</option>
                        </select>
                        <input type="text" placeholder="Description" value={fxExpDesc} onChange={e => setFxExpDesc(e.target.value)}
                          className="bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                        <input type="number" placeholder="Amount" value={fxExpAmt} onChange={e => setFxExpAmt(e.target.value)}
                          className="bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                        <input type="date" value={fxExpDate} onChange={e => setFxExpDate(e.target.value)}
                          className="bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none" />
                        <button onClick={handleAddFunctionExpense}
                          className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl active-shrink cursor-pointer">Add</button>
                      </div>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {functionExpenses.map(exp => (
                          <div key={exp.id} className="flex items-center justify-between bg-neo shadow-neo-inset-sm p-2.5 rounded-xl">
                            <div>
                              <p className="text-[11px] font-bold text-slate-800 dark:text-slate-200">{exp.description}</p>
                              <p className="text-[9px] text-slate-500 uppercase">{exp.expenseType} · {exp.expenseDate}{exp.receiptNumber ? ` · Receipt ${exp.receiptNumber}` : ''}</p>
                            </div>
                            <div className="flex items-center space-x-2">
                              <span className="text-xs font-mono font-bold text-red-500">{companyCurrency} {Number(exp.amount).toLocaleString()}</span>
                              <button onClick={() => handleDeleteFunctionExpense(exp.id)} className="text-red-400 hover:text-red-600 cursor-pointer"><Trash2 size={13} /></button>
                            </div>
                          </div>
                        ))}
                        {functionExpenses.length === 0 && <p className="text-slate-400 text-center py-6 text-xs">No expenses recorded yet.</p>}
                      </div>
                    </div>

                    {/* Signatures on file */}
                    {functionSignatures.length > 0 && (
                      <div className="bg-neo shadow-neo-outset border border-slate-200/5 p-4 rounded-2xl space-y-2">
                        <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase">Signatures on File</h4>
                        {functionSignatures.map(sig => (
                          <div key={sig.id} className="flex items-center justify-between bg-neo shadow-neo-inset-sm p-2.5 rounded-xl">
                            <div>
                              <p className="text-[11px] font-bold text-slate-800 dark:text-slate-200 capitalize">{sig.signatureType} confirmation — {sig.signeeName}</p>
                              <p className="text-[9px] text-slate-500">{new Date(sig.signedAt).toLocaleString()}{sig.confirmationNotes ? ` · ${sig.confirmationNotes}` : ''}</p>
                            </div>
                            <img src={sig.signatureData} alt="signature" className="h-8 bg-white rounded border border-slate-200/20" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* TAB 5: TIMELINE */}
              {activeFunctionTab === 'timeline' && (
                <div className="space-y-5">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Event Activity Timeline Log</h4>
                  
                  {/* Add manual note */}
                  <div className="flex items-center space-x-3">
                    <input
                      type="text"
                      placeholder="Add timeline entry note…"
                      value={newTimelineDescription}
                      onChange={e => setNewTimelineDescription(e.target.value)}
                      className="flex-1 bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                    <button
                      onClick={handleCreateTimelineActivity}
                      className="px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl active-shrink shadow-md transition-all shrink-0"
                    >
                      Post Note
                    </button>
                  </div>

                  {/* Timeline Feed */}
                  <div className="relative border-l border-slate-200/10 pl-4 ml-2 space-y-4 max-h-[50vh] overflow-y-auto py-2">
                    {functionActivities.map(act => (
                      <div key={act.id} className="relative text-xs font-medium space-y-1">
                        <div className="absolute -left-[21px] mt-1.5 w-2.5 h-2.5 rounded-full bg-blue-600 shadow-lg border border-white dark:border-slate-900" />
                        <div className="text-[10px] text-slate-400 font-mono">
                          {new Date(act.createdAt).toLocaleString()}
                        </div>
                        <p className="text-slate-700 dark:text-slate-300 pl-1">{act.description}</p>
                      </div>
                    ))}
                    {functionActivities.length === 0 && (
                      <p className="text-slate-400 text-center py-10 font-medium">Timeline log is empty.</p>
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* REPORT SYSTEM INCIDENT MODAL */}
      {showIncidentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-md space-y-5 animate-fade-in">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Report System Incident</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Log a diagnostic outage or warning event</p>
              </div>
              <button
                onClick={() => setShowIncidentModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer border-none"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Affected Component *</label>
                <select
                  value={incidentComponentId}
                  onChange={e => setIncidentComponentId(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer font-semibold text-slate-700 dark:text-slate-300"
                >
                  {systemComponents.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Incident Title *</label>
                <input
                  type="text"
                  placeholder="e.g. Authentication Server Timeout"
                  value={incidentTitle}
                  onChange={e => setIncidentTitle(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Severity Level</label>
                <select
                  value={incidentSeverity}
                  onChange={e => setIncidentSeverity(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer font-semibold text-slate-700 dark:text-slate-300"
                >
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="critical">Critical</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Diagnostic Details / Log Message *</label>
                <textarea
                  rows={3}
                  placeholder="Describe the degradation symptoms, error logs, or resolution plan..."
                  value={incidentMessage}
                  onChange={e => setIncidentMessage(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none resize-none"
                />
              </div>
            </div>

            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => setShowIncidentModal(false)}
                className="flex-1 py-2.5 bg-neo shadow-neo-outset hover:shadow-neo-inset text-slate-600 dark:text-slate-400 font-bold text-xs rounded-xl active-shrink transition-all cursor-pointer border-none"
              >
                Cancel
              </button>
              <button
                onClick={handleLogIncident}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-md active-shrink transition-all cursor-pointer border-none"
              >
                Log Incident
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HELP GUIDE ARTICLE READER MODAL */}
      {selectedArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-0 w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-slate-200/10 shrink-0">
              <div className="flex items-center space-x-3">
                <div className="w-9 h-9 rounded-xl bg-blue-600/15 border border-blue-500/20 flex items-center justify-center">
                  <FileText size={16} className="text-blue-500" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-800 dark:text-white">{selectedArticle.title}</h3>
                  <p className="text-[10px] text-slate-400 font-mono mt-0.5">Last updated: {new Date(selectedArticle.updatedAt).toLocaleDateString()}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedArticle(null)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer transition-all"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="overflow-y-auto flex-1 p-6">
              <div className="bg-neo shadow-neo-inset-sm rounded-2xl p-5 space-y-3">
                {selectedArticle.content.split('\n').map((line: string, idx: number) => {
                  if (line.startsWith('### ')) {
                    return <h4 key={idx} className="text-xs font-black text-slate-800 dark:text-white uppercase tracking-wide border-b border-slate-200/10 pb-1 mb-1">{line.replace('### ', '')}</h4>;
                  }
                  if (line.match(/^\d+\. /)) {
                    const parts = line.split('**');
                    return (
                      <div key={idx} className="flex space-x-3 items-start">
                        <span className="shrink-0 w-5 h-5 rounded-full bg-blue-600/15 border border-blue-500/20 text-blue-600 font-black text-[9px] flex items-center justify-center mt-0.5">
                          {line.match(/^(\d+)/)?.[1]}
                        </span>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed flex-1">
                          {parts.map((part, pi) =>
                            pi % 2 === 1
                              ? <strong key={pi} className="font-black text-slate-800 dark:text-slate-200">{part}</strong>
                              : <span key={pi}>{part.replace(/^\d+\. /, '')}</span>
                          )}
                        </p>
                      </div>
                    );
                  }
                  if (line.trim() === '') return <div key={idx} className="h-1" />;
                  return <p key={idx} className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{line}</p>;
                })}
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-slate-200/10 flex justify-end shrink-0">
              <button
                onClick={() => setSelectedArticle(null)}
                className="px-5 py-2.5 bg-neo shadow-neo-outset hover:shadow-neo-inset text-slate-700 dark:text-slate-300 font-bold text-xs rounded-xl active-shrink transition-all cursor-pointer"
              >
                Close Guide
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NEW CONSUMABLE REGISTER MODAL */}
      {showConsumableModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-md space-y-5 animate-fade-in my-8 max-h-[90vh] overflow-y-auto scrollbar-thin">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">New Consumable Stock</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Register a non-serialized one-way consumable item</p>
              </div>
              <button
                onClick={() => setShowConsumableModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1 col-span-2">
                  <label className="text-[10px] uppercase font-bold text-slate-500">Item Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Gaffer Tape Red"
                    value={consName}
                    onChange={e => setConsName(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500">Category</label>
                  <select
                    value={consCategory}
                    onChange={e => setConsCategory(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                  >
                    <option value="general">General</option>
                    <option value="stationery">Stationery</option>
                    <option value="supplies">Event Supplies</option>
                    <option value="fuel">Fuel & Gas</option>
                    <option value="packaging">Packaging</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500">SKU / Code</label>
                  <input
                    type="text"
                    placeholder="e.g. SK-4982"
                    value={consSku}
                    onChange={e => setConsSku(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500">Initial Stock</label>
                  <input
                    type="number"
                    placeholder="0"
                    value={consStockQty}
                    onChange={e => setConsStockQty(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500">Min Stock Warning</label>
                  <input
                    type="number"
                    placeholder="0"
                    value={consRestockLevel}
                    onChange={e => setConsRestockLevel(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>

              {/* UoM Configuration */}
              <div className="border-t border-slate-200/10 pt-3.5 space-y-3">
                <div className="flex items-center justify-between p-3 bg-neo shadow-neo-inset-sm rounded-xl select-none">
                  <span className="text-[11px] font-bold text-slate-700 dark:text-slate-350 cursor-pointer">Advanced Multi-Unit Scaling</span>
                  <input 
                    type="checkbox" 
                    checked={consIsMultiUnit} 
                    onChange={e => {
                      const enabling = e.target.checked;
                      setConsIsMultiUnit(enabling);
                      if (enabling) {
                        setConsPackageUnitId(consUnitOfMeasureId);
                        setConsPieceUnitId('');
                      } else {
                        setConsPackageUnitId('');
                        setConsPieceUnitId('');
                      }
                    }} 
                    className="w-4 h-4 text-blue-600 border-none shadow-neo-inset-sm rounded bg-neo focus:ring-blue-500/30 cursor-pointer" 
                  />
                </div>

                {!consIsMultiUnit ? (
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-slate-500">Base Inventory Unit</label>
                    <SearchableUnitSelect
                      options={uoms}
                      value={consUnitOfMeasureId}
                      onChange={setConsUnitOfMeasureId}
                    />
                  </div>
                ) : (
                  <div className="space-y-3.5">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500">Big Unit (Package)</label>
                        <SearchableUnitSelect
                          options={uoms}
                          value={consPackageUnitId}
                          onChange={setConsPackageUnitId}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500">Small Unit (Piece)</label>
                        <SearchableUnitSelect
                          options={uoms}
                          value={consPieceUnitId}
                          onChange={setConsPieceUnitId}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 items-center">
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-slate-500">Ratio (Small per Big)</label>
                        <input
                          type="number"
                          value={consUnitRatio}
                          onChange={e => setConsUnitRatio(Math.max(1, parseInt(e.target.value) || 1))}
                          className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                        />
                      </div>
                      <div className="p-3 bg-neo shadow-neo-inset-sm rounded-xl text-[10px] font-bold text-slate-500 leading-tight">
                        {consPackageUnitId && consPieceUnitId && uoms.find(u => u.id === consPackageUnitId) && uoms.find(u => u.id === consPieceUnitId) ? (
                          <p className="text-blue-650 dark:text-blue-400">
                            1 {uoms.find(u => u.id === consPackageUnitId).abbreviation} = {consUnitRatio} {uoms.find(u => u.id === consPieceUnitId).abbreviation}
                          </p>
                        ) : (
                          <p>Select units above</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 border-t border-slate-200/10 pt-3.5">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500">Unit Cost ({activeCompany.currency || 'UGX'})</label>
                  <input
                    type="number"
                    placeholder="0"
                    value={consCostPrice}
                    onChange={e => setConsCostPrice(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 font-extrabold text-slate-700 dark:text-slate-350">
                    {consIsMultiUnit ? "Package Price" : `Retail Price (${activeCompany.currency || 'UGX'})`}
                  </label>
                  <input
                    type="number"
                    placeholder="0"
                    value={consIsMultiUnit ? consPackagePrice : consUnitPrice}
                    onChange={e => consIsMultiUnit ? setConsPackagePrice(e.target.value) : setConsUnitPrice(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>

              {consIsMultiUnit && consPackagePrice && consUnitRatio > 0 && (
                <div className="p-3 bg-neo shadow-neo-inset-sm rounded-xl text-[10px] font-bold text-slate-500">
                  <p>
                    Derived Piece Price: <span className="text-blue-650 dark:text-blue-400 font-mono">{activeCompany.currency || 'UGX'} {(parseFloat(consPackagePrice) / consUnitRatio).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> each
                  </p>
                </div>
              )}
            </div>

            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => setShowConsumableModal(false)}
                className="flex-1 py-2.5 bg-neo shadow-neo-outset hover:shadow-neo-inset text-slate-600 dark:text-slate-400 font-bold text-xs rounded-xl active-shrink transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateConsumable}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-md active-shrink transition-all cursor-pointer"
              >
                Register Item
              </button>
            </div>
          </div>
        </div>
      )}

      {/* USE CONSUMABLE STOCK MODAL */}
      {showConsumableUseModal && selectedConsumable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-sm space-y-5 animate-fade-in">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Record Consumable Usage</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">{selectedConsumable.name} (Stock: {selectedConsumable.stockQty})</p>
              </div>
              <button
                onClick={() => {
                  setShowConsumableUseModal(false);
                  setSelectedConsumable(null);
                }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Quantity Consumed *</label>
                <input
                  type="number"
                  placeholder="0"
                  value={consUseQty}
                  onChange={e => setConsUseQty(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Usage Notes / Details *</label>
                <input
                  type="text"
                  placeholder="e.g. Used for VIP Tent setup"
                  value={consUseNotes}
                  onChange={e => setConsUseNotes(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              {/* Only consumables hold stock at URA, and only once registered. */}
              {efrisConfig.enabled && efrisConfig.configured && (selectedConsumable as any).efrisRegisteredAt && (
                <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-2 border border-transparent">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300">Also report this to URA</span>
                    <input
                      type="checkbox"
                      checked={consUseToUra}
                      onChange={e => setConsUseToUra(e.target.checked)}
                      className="w-4 h-4 accent-blue-600 cursor-pointer"
                    />
                  </label>
                  {consUseToUra && (
                    <div className="space-y-1">
                      <label className="text-[9px] uppercase font-bold text-slate-500 block">Reason (URA adjustment type)</label>
                      <select
                        value={consUseUraType}
                        onChange={e => setConsUseUraType(e.target.value)}
                        className="w-full bg-neo shadow-neo-outset border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none"
                      >
                        {STOCK_ADJUST_TYPES.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
                      </select>
                      {consUseUraType === '104' && (
                        <p className="text-[9px] text-amber-600 dark:text-amber-400">URA requires a note above when the reason is "Others".</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => {
                  setShowConsumableUseModal(false);
                  setSelectedConsumable(null);
                }}
                className="flex-1 py-2.5 bg-neo shadow-neo-outset hover:shadow-neo-inset text-slate-600 dark:text-slate-400 font-bold text-xs rounded-xl active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleUseConsumable}
                className="flex-1 py-2.5 bg-orange-600 hover:bg-orange-700 text-white font-bold text-xs rounded-xl shadow-md active-shrink transition-all cursor-pointer"
              >
                Log Consumption
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RESTOCK CONSUMABLE MODAL */}
      {showConsumableRestockModal && selectedConsumable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-sm space-y-5 animate-fade-in">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Replenish Consumable Stock</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">{selectedConsumable.name} (Stock: {selectedConsumable.stockQty})</p>
              </div>
              <button
                onClick={() => {
                  setShowConsumableRestockModal(false);
                  setSelectedConsumable(null);
                }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Restock Quantity *</label>
                <input
                  type="number"
                  placeholder="0"
                  value={consRestockQty}
                  onChange={e => setConsRestockQty(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">New Unit Cost ({activeCompany.currency || 'UGX'})</label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={consRestockCost}
                  onChange={e => setConsRestockCost(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Vendor / Purchase Notes</label>
                <input
                  type="text"
                  placeholder="e.g. Purchased from Mukwano Supplies Ltd"
                  value={consRestockNotes}
                  onChange={e => setConsRestockNotes(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            {efrisConfig.enabled && efrisConfig.configured && (selectedConsumable as any).efrisRegisteredAt && (
              <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-2 border border-transparent">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300">Also report this to URA</span>
                  <input
                    type="checkbox"
                    checked={consRestockToUra}
                    onChange={e => setConsRestockToUra(e.target.checked)}
                    className="w-4 h-4 accent-blue-600 cursor-pointer"
                  />
                </label>
                {consRestockToUra && (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <label className="text-[9px] uppercase font-bold text-slate-500 block">How the stock came in</label>
                      <select
                        value={consRestockUraType}
                        onChange={e => setConsRestockUraType(e.target.value)}
                        className="w-full bg-neo shadow-neo-outset border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none"
                      >
                        {STOCK_IN_TYPES.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
                      </select>
                    </div>
                    {/* URA's rules are mutually exclusive: manufactured stock has a
                        batch and no supplier; everything else has a supplier. */}
                    {consRestockUraType === '103' ? (
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500 block">Production batch no. *</label>
                        <input
                          value={consRestockBatchNo}
                          onChange={e => setConsRestockBatchNo(e.target.value)}
                          className="w-full bg-neo shadow-neo-outset border-none p-2 rounded-lg text-[11px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
                        />
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-[9px] uppercase font-bold text-slate-500 block">Supplier *</label>
                          <input
                            value={consRestockSupplier}
                            onChange={e => setConsRestockSupplier(e.target.value)}
                            className="w-full bg-neo shadow-neo-outset border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[9px] uppercase font-bold text-slate-500 block">Supplier TIN</label>
                          <input
                            value={consRestockSupplierTin}
                            onChange={e => setConsRestockSupplierTin(e.target.value)}
                            className="w-full bg-neo shadow-neo-outset border-none p-2 rounded-lg text-[11px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => {
                  setShowConsumableRestockModal(false);
                  setSelectedConsumable(null);
                }}
                className="flex-1 py-2.5 bg-neo shadow-neo-outset hover:shadow-neo-inset text-slate-600 dark:text-slate-400 font-bold text-xs rounded-xl active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleRestockConsumable}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-md active-shrink transition-all cursor-pointer"
              >
                Log Restock
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CONSUMABLE AUDIT LOGS MODAL */}
      {showConsumableLogsModal && selectedConsumable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto space-y-5 animate-fade-in">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Stock Audit History</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">{selectedConsumable.name} (SKU: {selectedConsumable.sku || 'N/A'})</p>
              </div>
              <button
                onClick={() => {
                  setShowConsumableLogsModal(false);
                  setSelectedConsumable(null);
                  setConsumableLogs([]);
                }}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="bg-neo shadow-neo-inset-sm border border-slate-200/5 rounded-2xl overflow-hidden max-h-[50vh] overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200/10 text-[10px] text-slate-500 uppercase font-black bg-slate-200/5">
                    <th className="p-3">Date</th>
                    <th className="p-3">Action</th>
                    <th className="p-3 text-center">Qty Change</th>
                    <th className="p-3">operator</th>
                    <th className="p-3">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/10 text-slate-600 dark:text-slate-300">
                  {consumableLogs.map(log => (
                    <tr key={log.id} className="hover:bg-slate-200/5">
                      <td className="p-3 font-mono">{new Date(log.createdAt).toLocaleString()}</td>
                      <td className="p-3 capitalize">
                        <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                          log.action === 'use' ? 'bg-orange-500/10 text-orange-600 border border-orange-500/20' :
                          log.action === 'restock' ? 'bg-green-500/10 text-green-600 border border-green-500/20' :
                          'bg-slate-500/10 text-slate-500 border border-slate-500/20'
                        }`}>
                          {log.action}
                        </span>
                      </td>
                      <td className="p-3 text-center font-mono font-bold">{log.quantity}</td>
                      <td className="p-3 font-semibold">{log.operator}</td>
                      <td className="p-3 text-slate-500 font-medium">{log.notes}</td>
                    </tr>
                  ))}
                  {consumableLogs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-400 font-medium">No logs written for this item.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end pt-1">
              <button
                onClick={() => {
                  setShowConsumableLogsModal(false);
                  setSelectedConsumable(null);
                  setConsumableLogs([]);
                }}
                className="px-5 py-2.5 bg-neo shadow-neo-outset hover:shadow-neo-inset text-slate-700 dark:text-slate-300 font-bold text-xs rounded-xl active-shrink transition-all cursor-pointer"
              >
                Close Audit Viewer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECORD MISCELLANEOUS INCOME MODAL */}
      {showManualIncomeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-md space-y-5 animate-fade-in">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">Record Cash Inflow</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Record direct miscellaneous cash inflow in the Consolidated Revenue Register</p>
              </div>
              <button
                onClick={() => setShowManualIncomeModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Inflow Amount ({activeCompany.currency || 'UGX'}) *</label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={newIncAmount}
                  onChange={e => setNewIncAmount(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Payment Method *</label>
                <select
                  value={newIncMethod}
                  onChange={e => setNewIncMethod(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                >
                  <option value="cash">Cash</option>
                  <option value="check">Check</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="bank_transfer">Bank Wire Transfer</option>
                  <option value="stripe">Stripe</option>
                  <option value="mobile_money">Mobile Money</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Reference / Receipt Number</label>
                <input
                  type="text"
                  placeholder="e.g. REC-98210"
                  value={newIncReference}
                  onChange={e => setNewIncReference(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500">Description / Memo *</label>
                <input
                  type="text"
                  placeholder="e.g. Sale of obsolete sound cables"
                  value={newIncDescription}
                  onChange={e => setNewIncDescription(e.target.value)}
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => setShowManualIncomeModal(false)}
                className="flex-1 py-3 bg-neo shadow-neo-outset hover:shadow-neo-inset text-slate-600 dark:text-slate-400 font-bold text-xs rounded-xl active-shrink transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleRecordManualIncome}
                className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-md active-shrink transition-all cursor-pointer"
              >
                Post Inflow
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CREATE CUSTOMER MODAL */}
      {showCustomerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-md space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white">New Customer</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Add a customer to the register</p>
              </div>
              <button
                onClick={() => setShowCustomerModal(false)}
                className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Full Name *</label>
                <input
                  type="text"
                  value={newCustName}
                  onChange={e => setNewCustName(e.target.value)}
                  placeholder="E.g. John Ssekandi"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Contact Info</label>
                <input
                  type="text"
                  value={newCustContact}
                  onChange={e => setNewCustContact(e.target.value)}
                  placeholder="Phone, email, address…"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">TIN</label>
                <input
                  type="text"
                  value={newCustTin}
                  onChange={e => setNewCustTin(e.target.value)}
                  placeholder="For businesses — leave blank for individuals"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
                />
                <p className="text-[9px] text-slate-400">With a TIN their invoices go to URA as B2B; without one, as B2C.</p>
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button
                onClick={() => setShowCustomerModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateCustomer}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Add Customer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NEW BOOKING MODAL — wide centred two-column layout */}
      {showBookingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6">
          <div className="w-full max-w-5xl max-h-[92vh] bg-neo shadow-neo-outset border border-slate-200/5 rounded-3xl flex flex-col animate-in zoom-in-95 duration-150 overflow-hidden">

            {/* ── Modal Header ── */}
            <div className="flex items-center justify-between border-b border-slate-200/10 px-8 py-5 shrink-0">
              <div>
                <h3 className="text-sm font-extrabold text-slate-800 dark:text-white uppercase tracking-wide">Create New Booking</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Scoped to {activeCompany.name}</p>
              </div>
              <button
                onClick={() => setShowBookingModal(false)}
                className="w-8 h-8 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm flex items-center justify-center text-slate-400 active-shrink"
              >
                <X size={16} />
              </button>
            </div>

            {/* ── Body: left = form, right = catalog + cart ── */}
            <div className="flex flex-1 min-h-0 divide-x divide-slate-200/10">

              {/* LEFT — Booking details form */}
              <div className="w-[40%] shrink-0 px-8 py-6 overflow-y-auto space-y-5">
                <p className="text-[10px] uppercase font-black text-slate-400 tracking-widest">Booking Details</p>

                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Customer Name *</label>
                    <input
                      type="text"
                      value={newCustomerName}
                      onChange={(e) => setNewCustomerName(e.target.value)}
                      placeholder="Enter customer name"
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Contact Info</label>
                    <input
                      type="text"
                      value={newContactInfo}
                      onChange={(e) => setNewContactInfo(e.target.value)}
                      placeholder="Email or phone number"
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Booking Type</label>
                    <select
                      value={newBookingType}
                      onChange={(e) => setNewBookingType(e.target.value as any)}
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                    >
                      <option value="customer">Customer Rental</option>
                      <option value="function">Internal Function Hires</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-bold text-slate-500 block">Secured Deposit (UGX)</label>
                    <input
                      type="number"
                      value={newDeposit || ''}
                      onChange={(e) => setNewDeposit(Number(e.target.value))}
                      placeholder="E.g. 100,000"
                      className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Pickup Date *</label>
                      <input
                        type="date"
                        value={newPickupDate}
                        onChange={(e) => setNewPickupDate(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase font-bold text-slate-500 block">Expected Return *</label>
                      <input
                        type="date"
                        value={newReturnDate}
                        onChange={(e) => setNewReturnDate(e.target.value)}
                        className="w-full bg-neo shadow-neo-inset-sm border-none p-3 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Total + Actions pinned to bottom of left column */}
                <div className="border-t border-slate-200/10 pt-5 mt-auto space-y-3">
                  <div>
                    <p className="text-[10px] uppercase font-bold text-slate-500">Calculated Booking Total</p>
                    <h3 className="text-xl font-black font-mono text-green-600 dark:text-green-400 mt-0.5">
                      UGX {calculateBookingTotal(newBookingLineItems, newPickupDate, newReturnDate).toLocaleString()}
                    </h3>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setShowBookingModal(false)}
                      className="flex-1 py-2.5 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 transition-all active-shrink"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateBooking}
                      className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink transition-all"
                    >
                      Confirm Booking
                    </button>
                  </div>
                </div>
              </div>

              {/* RIGHT — Catalog + Cart */}
              <div className="flex-1 flex flex-col min-h-0">

                {/* TOP: scrollable catalog zone */}
                <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6 space-y-6">

                <div className="relative">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                  <input
                    type="text"
                    placeholder="Search items or consumables by name…"
                    value={catalogSearch}
                    onChange={e => setCatalogSearch(e.target.value)}
                    className="w-full pl-9 pr-10 py-2.5 bg-neo shadow-neo-inset-sm border-none rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                  {catalogSearch && (
                    <button
                      onClick={() => setCatalogSearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 active-shrink"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                {/* Hire Items Catalog */}
                {(() => {
                  const filteredItems = items.filter(i =>
                    !catalogSearch || i.name.toLowerCase().includes(catalogSearch.toLowerCase()) || i.category.toLowerCase().includes(catalogSearch.toLowerCase())
                  );
                  return (
                    <div className="space-y-3">
                      <p className="text-[10px] uppercase font-black text-slate-400 tracking-widest">
                        Hire Items Catalog
                        {catalogSearch && <span className="ml-2 text-blue-500 normal-case font-semibold">({filteredItems.length} match{filteredItems.length !== 1 ? 'es' : ''})</span>}
                      </p>
                      {filteredItems.length === 0 ? (
                        <p className="text-[10px] text-slate-400 py-2">No hire items match "{catalogSearch}".</p>
                      ) : (
                        <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
                          {filteredItems.map(item => (
                            <div
                              key={item.id}
                              onClick={() => handleAddItemToBooking(item.id, 'item')}
                              className="bg-neo shadow-neo-outset hover:shadow-neo-inset-sm border border-slate-200/5 p-3 rounded-xl cursor-pointer active-shrink select-none transition-all"
                            >
                              <p className="text-xs font-bold text-slate-800 dark:text-slate-200 leading-snug">{item.name}</p>
                              <span className="text-[10px] text-blue-600 dark:text-blue-400 font-mono">UGX {item.dailyRentalRate.toLocaleString()}/day</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Consumables Catalog */}
                {(() => {
                  const filteredCons = consumables.filter(c =>
                    !catalogSearch || c.name.toLowerCase().includes(catalogSearch.toLowerCase()) || (c.category || '').toLowerCase().includes(catalogSearch.toLowerCase())
                  );
                  return (
                    <div className="space-y-3">
                      <p className="text-[10px] uppercase font-black text-slate-400 tracking-widest">
                        Consumables Catalog
                        {catalogSearch && <span className="ml-2 text-blue-500 normal-case font-semibold">({filteredCons.length} match{filteredCons.length !== 1 ? 'es' : ''})</span>}
                      </p>
                      {filteredCons.length === 0 ? (
                        <p className="text-[10px] text-slate-400 py-1">
                          {consumables.length === 0 ? 'No consumables available.' : `No consumables match "${catalogSearch}".`}
                        </p>
                      ) : (
                        <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
                          {filteredCons.map(cons => {
                            if (cons.isMultiUnit) {
                              return (
                                <div key={cons.id} className="bg-neo shadow-neo-outset border border-slate-200/5 p-3 rounded-xl space-y-2">
                                  <p className="text-[10px] font-bold text-slate-700 dark:text-slate-300">{cons.name}</p>
                                  <div className="flex gap-1.5">
                                    <button
                                      onClick={() => handleAddItemToBooking(cons.id, 'consumable', cons.packageUnitId)}
                                      className="flex-1 px-2 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-lg text-[9px] font-bold text-slate-800 dark:text-slate-200 cursor-pointer active-shrink text-center"
                                    >
                                      + {cons.packageUnit?.abbreviation || 'Box'}
                                      <span className="block text-[8px] text-blue-600 dark:text-blue-400 font-mono">UGX {Number(cons.packagePrice).toLocaleString()}</span>
                                    </button>
                                    <button
                                      onClick={() => handleAddItemToBooking(cons.id, 'consumable', cons.pieceUnitId)}
                                      className="flex-1 px-2 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm rounded-lg text-[9px] font-bold text-slate-800 dark:text-slate-200 cursor-pointer active-shrink text-center"
                                    >
                                      + {cons.pieceUnit?.abbreviation || 'Pcs'}
                                      <span className="block text-[8px] text-blue-600 dark:text-blue-400 font-mono">UGX {Number(cons.unitPrice).toLocaleString()}</span>
                                    </button>
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <div
                                key={cons.id}
                                onClick={() => handleAddItemToBooking(cons.id, 'consumable', cons.unitOfMeasureId)}
                                className="bg-neo shadow-neo-outset hover:shadow-neo-inset-sm border border-slate-200/5 p-3 rounded-xl cursor-pointer active-shrink select-none transition-all"
                              >
                                <p className="text-xs font-bold text-slate-800 dark:text-slate-200 leading-snug">{cons.name}</p>
                                <span className="text-[10px] text-blue-600 dark:text-blue-400 font-mono">
                                  UGX {Number(cons.unitPrice).toLocaleString()} ({cons.unitOfMeasure?.abbreviation || 'unit'})
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
                </div>{/* end scrollable catalog zone */}

                {/* BOTTOM: pinned cart — always visible */}
                <div className="shrink-0 border-t border-slate-200/10 px-8 py-4 space-y-3 max-h-64 overflow-y-auto">
                  <p className="text-[10px] uppercase font-black text-slate-400 tracking-widest sticky top-0 bg-neo py-1">
                    Selected Cart Items
                    {newBookingLineItems.length > 0 && (
                      <span className="ml-2 bg-blue-600 text-white text-[9px] font-extrabold px-1.5 py-0.5 rounded-full">{newBookingLineItems.length}</span>
                    )}
                  </p>
                  {newBookingLineItems.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-6 bg-neo shadow-neo-inset-sm rounded-xl">
                      Click any item above to add it to the booking.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {newBookingLineItems.map((item, index) => {
                        const isConsumable = item.itemType === 'consumable';
                        const name = isConsumable
                          ? (consumables.find(c => c.id === item.consumableId)?.name || 'Consumable')
                          : (items.find(i => i.id === item.itemId)?.name || 'Hire Item');

                        let priceLabel = '';
                        if (isConsumable) {
                          const cons = consumables.find(c => c.id === item.consumableId)!;
                          const uom = uoms.find(u => u.id === item.unitOfMeasureId);
                          const rate = Number(item.unitOfMeasureId) === cons.packageUnitId ? Number(cons.packagePrice) : Number(cons.unitPrice);
                          priceLabel = `UGX ${rate.toLocaleString()} (${uom?.abbreviation || 'flat'})`;
                        } else {
                          const it = items.find(i => i.id === item.itemId)!;
                          priceLabel = `UGX ${it.dailyRentalRate.toLocaleString()}/day`;
                        }

                        return (
                          <div key={index} className="bg-neo shadow-neo-outset border border-slate-200/5 px-4 py-3 rounded-xl flex items-center justify-between gap-4">
                            <div className="truncate flex-1">
                              <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">{name}</p>
                              <span className="text-[10px] text-slate-500 font-mono">{priceLabel}</span>
                            </div>

                            <div className="flex items-center gap-3 shrink-0">
                              <div className="flex items-center space-x-1.5 bg-neo shadow-neo-inset-sm p-1 rounded-lg">
                                <button
                                  onClick={() => setNewBookingLineItems(newBookingLineItems.map((b, idx) => idx === index ? { ...b, quantity: Math.max(1, b.quantity - 1) } : b))}
                                  className="w-5 h-5 rounded-md bg-neo shadow-neo-outset hover:shadow-neo-inset-sm flex items-center justify-center font-black active-shrink text-xs"
                                >−</button>
                                <span className="text-xs font-bold font-mono px-2">{item.quantity}</span>
                                <button
                                  onClick={() => setNewBookingLineItems(newBookingLineItems.map((b, idx) => idx === index ? { ...b, quantity: b.quantity + 1 } : b))}
                                  className="w-5 h-5 rounded-md bg-neo shadow-neo-outset hover:shadow-neo-inset-sm flex items-center justify-center font-black active-shrink text-xs"
                                >+</button>
                              </div>
                              <button
                                onClick={() => setNewBookingLineItems(newBookingLineItems.filter((_, idx) => idx !== index))}
                                className="text-red-500 hover:text-red-600 active-shrink"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>
            </div>
          </div>
        </div>
      )}

      {/* NEW BULK ITEM MODAL */}
      {showItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-6">
          <div className="w-full max-w-md bg-neo shadow-neo-outset border border-slate-200/5 rounded-3xl p-6 space-y-6 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-4">
              <div>
                <h3 className="text-sm font-extrabold text-slate-800 dark:text-white uppercase">New Bulk Inventory Item</h3>
                <p className="text-[10px] text-slate-400">Add bulk item to catalog</p>
              </div>
              <button 
                onClick={() => setShowItemModal(false)}
                className="w-8 h-8 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm flex items-center justify-center text-slate-400 active-shrink cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Item Name *</label>
                <input 
                  type="text" 
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  placeholder="E.g. Banquet Chairs" 
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Category</label>
                  <select 
                    value={newItemCategory}
                    onChange={(e) => setNewItemCategory(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  >
                    <option value="Chairs">Chairs</option>
                    <option value="Tents">Tents</option>
                    <option value="Sound">Sound</option>
                    <option value="Power">Power</option>
                    <option value="Tables">Tables</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">UoM</label>
                  <input 
                    type="text" 
                    value={newItemUom}
                    onChange={(e) => setNewItemUom(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Cost Price (UGX)</label>
                  <input 
                    type="number" 
                    value={newItemCost || ''}
                    onChange={(e) => setNewItemCost(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Replacement Cost</label>
                  <input 
                    type="number" 
                    value={newItemReplacementCost || ''}
                    onChange={(e) => setNewItemReplacementCost(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Daily Rental (UGX) *</label>
                  <input 
                    type="number" 
                    value={newItemRate || ''}
                    onChange={(e) => setNewItemRate(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Initial Stock Qty</label>
                  <input 
                    type="number" 
                    value={newItemStock || ''}
                    onChange={(e) => setNewItemStock(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button 
                onClick={() => setShowItemModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={handleCreateItem}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Create Item
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NEW SERIALIZED ASSET MODAL */}
      {showAssetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-6">
          <div className="w-full max-w-md bg-neo shadow-neo-outset border border-slate-200/5 rounded-3xl p-6 space-y-6 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-4">
              <div>
                <h3 className="text-sm font-extrabold text-slate-800 dark:text-white uppercase">New Serialized Asset</h3>
                <p className="text-[10px] text-slate-400">Add tracked asset unit</p>
              </div>
              <button 
                onClick={() => setShowAssetModal(false)}
                className="w-8 h-8 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm flex items-center justify-center text-slate-400 active-shrink cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">Asset Name *</label>
                <input 
                  type="text" 
                  value={newAssetName}
                  onChange={(e) => setNewAssetName(e.target.value)}
                  placeholder="E.g. Honda Generator unit A" 
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Asset Type</label>
                  <select 
                    value={newAssetType}
                    onChange={(e) => setNewAssetType(e.target.value)}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                  >
                    <option value="Chairs">Chairs</option>
                    <option value="Tents">Tents</option>
                    <option value="Sound">Sound</option>
                    <option value="Power">Power</option>
                    <option value="Tables">Tables</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Serial Number *</label>
                  <input 
                    type="text" 
                    value={newAssetSerial}
                    onChange={(e) => setNewAssetSerial(e.target.value)}
                    placeholder="E.g. SN-GEN-908"
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Cost (UGX)</label>
                  <input 
                    type="number" 
                    value={newAssetCost || ''}
                    onChange={(e) => setNewAssetCost(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Daily rate</label>
                  <input 
                    type="number" 
                    value={newAssetRate || ''}
                    onChange={(e) => setNewAssetRate(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 block">Replacement</label>
                  <input 
                    type="number" 
                    value={newAssetReplacement || ''}
                    onChange={(e) => setNewAssetReplacement(Number(e.target.value))}
                    className="w-full bg-neo shadow-neo-inset-sm border-none p-2 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-3 border-t border-slate-200/10 pt-4">
              <button 
                onClick={() => setShowAssetModal(false)}
                className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={handleCreateAsset}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg hover:shadow-blue-500/25 active-shrink cursor-pointer"
              >
                Create Asset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INVOICE PRINT PREVIEW MODAL */}
      {activeInvoiceToPrint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto no-print animate-fade-in">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-3xl space-y-6 bg-white dark:bg-slate-900 border border-slate-200/10">
            
            {/* Header bar */}
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3 no-print">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white uppercase tracking-wider">Invoice Document Preview</h3>
                <p className="text-[10px] text-slate-500">Corporate invoice template for paper print or PDF export</p>
              </div>
              <div className="flex items-center space-x-3">
                <button
                  onClick={() => openServerPdf(`/api/invoices/${activeInvoiceToPrint.id}/pdf`)}
                  className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-blue-600 dark:text-blue-400 font-bold text-xs active-shrink cursor-pointer transition-all"
                >
                  Download PDF
                </button>
                <button
                  onClick={() => window.print()}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md active-shrink cursor-pointer transition-all"
                >
                  Print / Save PDF
                </button>
                <button
                  onClick={() => setActiveInvoiceToPrint(null)}
                  className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Document sheet */}
            <div className="p-8 border border-slate-200/10 rounded-2xl bg-white text-slate-900 space-y-6 font-sans">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-xl font-black text-blue-600 uppercase tracking-wide">INVOICE</h2>
                  <p className="text-xs font-mono font-bold text-slate-500 mt-1">Ref: {activeInvoiceToPrint.referenceNumber}</p>
                </div>
                <div className="text-right text-xs">
                  <h3 className="font-extrabold text-slate-800">{activeCompany.name}</h3>
                  <p className="text-slate-400">Universal Rental Engine Tenant</p>
                  <p className="text-slate-400">Kampala, Uganda</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 text-xs border-t border-b border-slate-200/10 py-4 font-sans">
                <div>
                  <p className="font-bold text-slate-400 uppercase tracking-wider text-[9px]">Bill To</p>
                  <h4 className="font-extrabold text-slate-800 mt-1">{activeInvoiceToPrint.customerName}</h4>
                  <p className="text-slate-500">Universal Customer Directory Registry</p>
                </div>
                <div className="text-right space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Issue Date:</span>
                    <span className="font-mono text-slate-700">{new Date(activeInvoiceToPrint.createdAt || Date.now()).toISOString().split('T')[0]}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Due Date:</span>
                    <span className="font-mono text-slate-700">{activeInvoiceToPrint.dueDate}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Payment Status:</span>
                    <span className={`font-bold uppercase ${activeInvoiceToPrint.status === 'Paid' ? 'text-green-600' : 'text-red-500'}`}>{activeInvoiceToPrint.status}</span>
                  </div>
                </div>
              </div>

              {/* Items grid. Amounts are shown NET with tax in its own column, so
                  the column adds up to the subtotal and subtotal + tax reaches the
                  total — the standard tax-invoice layout. */}
              <div className="space-y-4">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 uppercase text-[9px] font-bold">
                      <th className="py-2">Description</th>
                      <th className="py-2 text-right">Rate</th>
                      <th className="py-2 text-center">Qty / Period</th>
                      <th className="py-2 text-right">Tax</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(activeInvoiceToPrint.lineItems && activeInvoiceToPrint.lineItems.length > 0)
                      ? activeInvoiceToPrint.lineItems.map((l: InvoiceLine) => {
                          const days = Math.max(1, l.rentalDays || 1);
                          return (
                            <tr key={l.id} className="border-b border-slate-100">
                              <td className="py-3 font-medium">{l.description}</td>
                              <td className="py-3 text-right font-mono">{Number(l.unitPrice).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                              <td className="py-3 text-center font-mono">{Number(l.quantity)}{days > 1 ? ` × ${days} days` : ''}</td>
                              <td className="py-3 text-right font-mono">{Number(l.lineTax).toLocaleString()}</td>
                              <td className="py-3 text-right font-mono font-bold">{Number(l.lineNet).toLocaleString()}</td>
                            </tr>
                          );
                        })
                      : (
                        // Invoices raised before line items existed still print.
                        <tr className="border-b border-slate-100">
                          <td className="py-3 font-medium">{activeInvoiceToPrint.description}</td>
                          <td className="py-3 text-right font-mono">{Number(activeInvoiceToPrint.amount).toLocaleString()}</td>
                          <td className="py-3 text-center font-mono">1</td>
                          <td className="py-3 text-right font-mono">—</td>
                          <td className="py-3 text-right font-mono font-bold">{Number(activeInvoiceToPrint.amount).toLocaleString()}</td>
                        </tr>
                      )}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="flex justify-end pt-4 border-t border-slate-200">
                <div className="w-72 space-y-2 text-xs">
                  <div className="flex justify-between font-bold text-slate-400">
                    <span>Subtotal (excl. tax)</span>
                    <span className="font-mono text-slate-800">UGX {Number(activeInvoiceToPrint.subtotal ?? activeInvoiceToPrint.amount).toLocaleString()}</span>
                  </div>
                  {Number(activeInvoiceToPrint.discountTotal) > 0 && (
                    <div className="flex justify-between font-bold text-slate-400">
                      <span>Discount</span>
                      <span className="font-mono text-slate-800">-UGX {Number(activeInvoiceToPrint.discountTotal).toLocaleString()}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-slate-400">
                    <span>Tax</span>
                    <span className="font-mono text-slate-800">UGX {Number(activeInvoiceToPrint.taxTotal || 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between font-bold text-slate-400 border-t border-slate-100 pt-2">
                    <span>Total</span>
                    <span className="font-mono text-slate-800">UGX {Number(activeInvoiceToPrint.amount).toLocaleString()}</span>
                  </div>
                  {Number(activeInvoiceToPrint.amountPaid) > 0 && (
                    <div className="flex justify-between font-bold text-slate-400">
                      <span>Paid</span>
                      <span className="font-mono text-slate-800">-UGX {Number(activeInvoiceToPrint.amountPaid).toLocaleString()}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-black text-slate-800 border-t border-slate-100 pt-2">
                    <span>Balance Due</span>
                    <span className="font-mono text-green-600">
                      UGX {Number(activeInvoiceToPrint.balanceDue ?? (Number(activeInvoiceToPrint.amount) - Number(activeInvoiceToPrint.amountPaid || 0))).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              {/* The URA fiscal block, once the invoice has been reported */}
              {activeInvoiceToPrint.efrisFDN && (
                <div className="border border-blue-600 rounded-xl p-3 space-y-1">
                  <p className="text-[9px] font-black uppercase tracking-wide text-blue-700">URA EFRIS — Fiscalized e-Invoice</p>
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <p className="text-[9px] uppercase text-slate-400 font-bold">Fiscal Document Number</p>
                      <p className="text-sm font-black text-blue-700 font-mono break-all">{activeInvoiceToPrint.efrisFDN}</p>
                    </div>
                    <div className="text-right text-[10px] space-y-0.5">
                      {efrisConfig.tin && <p><span className="text-slate-400">Seller TIN: </span><span className="font-mono font-bold text-slate-700">{efrisConfig.tin}</span></p>}
                      {activeInvoiceToPrint.customerTin && <p><span className="text-slate-400">Buyer TIN: </span><span className="font-mono font-bold text-slate-700">{activeInvoiceToPrint.customerTin}</span></p>}
                      {activeInvoiceToPrint.efrisVerificationCode && <p><span className="text-slate-400">Verification: </span><span className="font-mono font-bold text-slate-700">{activeInvoiceToPrint.efrisVerificationCode}</span></p>}
                    </div>
                  </div>
                  {activeInvoiceToPrint.efrisQRCode && (
                    <p className="text-[9px] text-slate-400 break-all pt-1">Verify on the URA portal: {activeInvoiceToPrint.efrisQRCode}</p>
                  )}
                </div>
              )}
            </div>

          </div>
        </div>
      )}

      {/* BOOKING DEPOSIT RECEIPT PRINT MODAL */}
      {activeBookingToPrint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto no-print animate-fade-in">
          <div className="bg-neo shadow-neo-outset rounded-3xl p-6 w-full max-w-3xl space-y-6 bg-white dark:bg-slate-900 border border-slate-200/10">
            
            {/* Header bar */}
            <div className="flex items-center justify-between border-b border-slate-200/10 pb-3 no-print">
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-white uppercase tracking-wider">Deposit Receipt Preview</h3>
                <p className="text-[10px] text-slate-500">Corporate payment confirmation receipt for bookings</p>
              </div>
              <div className="flex items-center space-x-3">
                <button
                  onClick={() => openServerPdf(`/api/bookings/${activeBookingToPrint.id}/receipt-pdf`)}
                  className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-blue-600 dark:text-blue-400 font-bold text-xs active-shrink cursor-pointer transition-all"
                >
                  Download PDF
                </button>
                <button
                  onClick={() => window.print()}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md active-shrink cursor-pointer transition-all"
                >
                  Print / Save PDF
                </button>
                <button
                  onClick={() => setActiveBookingToPrint(null)}
                  className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Document sheet */}
            <div className="p-8 border border-slate-200/10 rounded-2xl bg-white text-slate-900 space-y-6 font-sans">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-xl font-black text-green-600 uppercase tracking-wide">DEPOSIT RECEIPT</h2>
                  <p className="text-xs font-mono font-bold text-slate-500 mt-1">Ref: {activeBookingToPrint.bookingNumber}</p>
                </div>
                <div className="text-right text-xs">
                  <h3 className="font-extrabold text-slate-800">{activeCompany.name}</h3>
                  <p className="text-slate-400">Universal Rental Engine Tenant</p>
                  <p className="text-slate-400">Kampala, Uganda</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 text-xs border-t border-b border-slate-200/10 py-4 font-sans">
                <div>
                  <p className="font-bold text-slate-400 uppercase tracking-wider text-[9px]">Issued To</p>
                  <h4 className="font-extrabold text-slate-800 mt-1">{activeBookingToPrint.customerName}</h4>
                  <p className="text-slate-500">Contact: {activeBookingToPrint.contactInfo || 'N/A'}</p>
                </div>
                <div className="text-right space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Pickup Date:</span>
                    <span className="font-mono text-slate-700">{activeBookingToPrint.scheduledPickupDate ? new Date(activeBookingToPrint.scheduledPickupDate).toISOString().split('T')[0] : 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Return Date:</span>
                    <span className="font-mono text-slate-700">{activeBookingToPrint.scheduledReturnDate ? new Date(activeBookingToPrint.scheduledReturnDate).toISOString().split('T')[0] : 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Deposit Status:</span>
                    <span className={`font-bold uppercase ${activeBookingToPrint.depositPaid ? 'text-green-600' : 'text-amber-500'}`}>
                      {activeBookingToPrint.depositPaid ? 'CLEARED' : 'PENDING'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Booking totals */}
              <div className="flex justify-end pt-4">
                <div className="w-64 space-y-2 text-xs">
                  <div className="flex justify-between font-bold text-slate-400">
                    <span>Estimated Total cost</span>
                    <span className="font-mono text-slate-800">UGX {Number(activeBookingToPrint.estimatedTotalCost).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm font-black text-slate-800 border-t border-slate-100 pt-2 font-black">
                    <span>Deposit Amount Paid</span>
                    <span className="font-mono text-green-600">UGX {Number(activeBookingToPrint.depositAmount).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}

export default App;
