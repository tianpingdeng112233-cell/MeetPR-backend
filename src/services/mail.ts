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

export async function sendCoachApplicationReceipt(
  input: MailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return sendMail(
    input,
    {
      subject: 'MeetPR 已收到你的教练申请',
      text: '已收到你的教练申请，通常 1 个工作日内处理，结果会发到这个邮箱。',
      html: '<p>已收到你的教练申请，通常 1 个工作日内处理，结果会发到这个邮箱。</p>',
    },
    fetchImpl,
  );
}

export async function sendCoachWelcomeEmail(
  input: MailInput & { url: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const installUrl = new URL('/coach/welcome#install', input.url).toString();
  const inviteUrl = new URL('/coach/welcome#invite', input.url).toString();
  return sendMail(
    input,
    {
      subject: '欢迎加入 MeetPR 内测',
      text: `你的教练申请已通过。\n设置密码：${input.url}\n链接 7 天内有效。\n安装 App：${installUrl}\n邀请学员：${inviteUrl}\n在 App 里选「登录」，用此邮箱和新密码。不要选「注册」。`,
      html: `<p>你的教练申请已通过。</p><p><a href="${escape(input.url)}">设置密码</a></p><p>链接 7 天内有效。</p><p><a href="${escape(installUrl)}">安装 App</a></p><p><a href="${escape(inviteUrl)}">邀请学员</a></p><p><strong>在 App 里选「登录」，用此邮箱和新密码。不要选「注册」。</strong></p>`,
    },
    fetchImpl,
  );
}

export async function sendCoachRejectionEmail(
  input: MailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return sendMail(
    input,
    {
      subject: 'MeetPR 教练申请结果',
      text: '你的本次 MeetPR 教练申请未通过。如有疑问，请联系邀请你参与内测的负责人。',
      html: '<p>你的本次 MeetPR 教练申请未通过。如有疑问，请联系邀请你参与内测的负责人。</p>',
    },
    fetchImpl,
  );
}
