const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

interface MailInput {
  apiKey: string;
  from: string;
  to: string;
  locale?: 'en' | 'zh';
}

export interface PasswordResetEmailInput extends MailInput {
  code: string;
}

interface MailContent {
  subject: string;
  text: string;
  html: string;
}

export async function sendPasswordResetEmail(
  input: PasswordResetEmailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = `Your MeetPR password reset code is ${input.code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`;
  const html = `<p>Your MeetPR password reset code is <strong>${input.code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`;
  return sendMail(
    input,
    input.locale === 'zh'
      ? {
          subject: 'MeetPR 重置密码验证码',
          text: `你的 MeetPR 重置密码验证码是 ${input.code}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
          html: `<p>你的 MeetPR 重置密码验证码是 <strong>${input.code}</strong>，10 分钟内有效。</p><p>如果不是你本人操作，请忽略这封邮件。</p>`,
        }
      : { subject: 'Your MeetPR password reset code', text, html },
    fetchImpl,
  );
}

export async function sendSignupCodeEmail(
  input: PasswordResetEmailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return sendMail(
    input,
    input.locale === 'zh'
      ? {
          subject: 'MeetPR 注册验证码',
          text: `你的 MeetPR 注册验证码是 ${input.code}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
          html: `<p>你的 MeetPR 注册验证码是 <strong>${input.code}</strong>，10 分钟内有效。</p><p>如果不是你本人操作，请忽略这封邮件。</p>`,
        }
      : {
          subject: 'Your MeetPR signup code',
          text: `Your MeetPR signup code is ${input.code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
          html: `<p>Your MeetPR signup code is <strong>${input.code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
        },
    fetchImpl,
  );
}

export async function sendAlreadyRegisteredEmail(
  input: MailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return sendMail(
    input,
    input.locale === 'zh'
      ? {
          subject: '你已经有 MeetPR 账号了',
          text: '这个邮箱已注册 MeetPR，请直接登录。忘了密码可在登录页找回。如果不是你本人操作，请忽略这封邮件。',
          html: '<p>这个邮箱已注册 MeetPR，请直接登录。忘了密码可在登录页找回。</p><p>如果不是你本人操作，请忽略这封邮件。</p>',
        }
      : {
          subject: 'You already have a MeetPR account',
          text: 'This email already has a MeetPR account. Please sign in, or reset your password on the sign-in page. If you did not request this, you can ignore this email.',
          html: '<p>This email already has a MeetPR account. Please sign in, or reset your password on the sign-in page.</p><p>If you did not request this, you can ignore this email.</p>',
        },
    fetchImpl,
  );
}

async function sendMail(
  input: MailInput,
  content: MailContent,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: input.from, to: [input.to], ...content }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Resend returned ${String(response.status)}`);
  }
}
