// Transactional email service (nodemailer).
//
// If SMTP_* env vars are configured it sends via real SMTP. Otherwise it uses a
// dev "capture" transport: the message is NOT sent anywhere, but it is rendered
// by nodemailer, logged, and kept in an in-memory ring buffer (devEmailLog) so
// the flow is fully exercisable in development without a mail server.
import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST;
const FROM = process.env.EMAIL_FROM || 'YourHires <no-reply@yourhires.app>';
export const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:20091';

export const usingRealSmtp = !!SMTP_HOST;

const transporter = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

// In-memory record of recently sent mail (dev visibility / verification).
export const devEmailLog: Array<{ to: string; subject: string; text: string; html: string; at: string }> = [];

export async function sendEmail(opts: { to: string; subject: string; text: string; html: string }) {
  try {
    await transporter.sendMail({ from: FROM, ...opts });
  } catch (err: any) {
    console.error('[EMAIL] send failed:', err.message);
  }
  devEmailLog.push({ to: opts.to, subject: opts.subject, text: opts.text, html: opts.html, at: new Date().toISOString() });
  if (devEmailLog.length > 50) devEmailLog.shift();
  console.log(`[EMAIL] to=${opts.to} subject="${opts.subject}" transport=${usingRealSmtp ? 'smtp' : 'dev-capture'}`);
}

// ── Shared HTML shell ──────────────────────────────────────────────────────
function shell(heading: string, bodyHtml: string) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">
  <div style="max-width:520px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
    <div style="height:6px;background:#2563eb;"></div>
    <div style="padding:28px 32px;">
      <h1 style="margin:0 0 4px;font-size:20px;color:#0f172a;">YourHires</h1>
      <p style="margin:0 0 20px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Rental &amp; Asset Management</p>
      <h2 style="font-size:17px;color:#0f172a;margin:0 0 12px;">${heading}</h2>
      ${bodyHtml}
    </div>
    <div style="padding:14px 32px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">You received this because an account action was requested on YourHires.</div>
  </div></body></html>`;
}

function button(url: string, label: string) {
  return `<a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:8px;">${label}</a>`;
}

// ── Templates ──────────────────────────────────────────────────────────────
export function buildVerificationEmail(to: string, name: string, verifyUrl: string) {
  return {
    to,
    subject: 'Verify your YourHires email address',
    text: `Hi ${name},\n\nPlease verify your email address by opening this link:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: shell('Confirm your email address',
      `<p style="font-size:14px;color:#334155;">Hi ${name}, welcome to YourHires. Please confirm your email address to secure your account.</p>
       <p style="margin:22px 0;">${button(verifyUrl, 'Verify Email')}</p>
       <p style="font-size:12px;color:#94a3b8;">This link expires in 24 hours. If the button doesn't work, copy this URL:<br><span style="word-break:break-all;color:#2563eb;">${verifyUrl}</span></p>`),
  };
}

export function buildPasswordResetEmail(to: string, name: string, resetUrl: string) {
  return {
    to,
    subject: 'Reset your YourHires password',
    text: `Hi ${name},\n\nA password reset was requested for your account. Open this link to set a new password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
    html: shell('Reset your password',
      `<p style="font-size:14px;color:#334155;">Hi ${name}, a password reset was requested for your account. Click below to choose a new password.</p>
       <p style="margin:22px 0;">${button(resetUrl, 'Reset Password')}</p>
       <p style="font-size:12px;color:#94a3b8;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>`),
  };
}
