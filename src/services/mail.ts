import { copy } from '../i18n/copy';
const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

interface MailInput {
  apiKey: string;
  from: string;
  to: string;
  locale?: 'en' | 'zh' | 'zh-Hant';
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
    input.locale === 'zh' || input.locale === 'zh-Hant'
      ? {
          subject: copy(input.locale, 'MeetPR 重置密码验证码'),
          text: copy(
            input.locale,
            '你的 MeetPR 重置密码验证码是 {0}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。',
            [input.code],
          ),
          html: copy(
            input.locale,
            '<p>你的 MeetPR 重置密码验证码是 <strong>{0}</strong>，10 分钟内有效。</p><p>如果不是你本人操作，请忽略这封邮件。</p>',
            [input.code],
          ),
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
    input.locale === 'zh' || input.locale === 'zh-Hant'
      ? {
          subject: copy(input.locale, 'MeetPR 注册验证码'),
          text: copy(
            input.locale,
            '你的 MeetPR 注册验证码是 {0}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。',
            [input.code],
          ),
          html: copy(
            input.locale,
            '<p>你的 MeetPR 注册验证码是 <strong>{0}</strong>，10 分钟内有效。</p><p>如果不是你本人操作，请忽略这封邮件。</p>',
            [input.code],
          ),
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
    input.locale === 'zh' || input.locale === 'zh-Hant'
      ? {
          subject: copy(input.locale, '你已经有 MeetPR 账号了'),
          text: copy(
            input.locale,
            '这个邮箱已注册 MeetPR，请直接登录。忘了密码可在登录页找回。如果不是你本人操作，请忽略这封邮件。',
          ),
          html: copy(
            input.locale,
            '<p>这个邮箱已注册 MeetPR，请直接登录。忘了密码可在登录页找回。</p><p>如果不是你本人操作，请忽略这封邮件。</p>',
          ),
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
  const loginUrl = new URL('/coach/login', input.url).toString();
  const intro = `你的教练申请已通过，账号已开通。登录邮箱：${input.to}。请按以下顺序开始使用。`;
  const steps = [
    {
      title: '1. 设置密码',
      description:
        '先为教练账号设置密码。设置密码链接 7 天内有效。之后在 App 和网页都使用这个邮箱和同一密码登录。',
      label: '设置我的密码',
      url: input.url,
    },
    {
      title: '2. 安装 App 并登录',
      description:
        '用手机打开安装指南，按页面提示安装 MeetPR 国内版。\niPhone：先从 App Store 下载 TestFlight，再回到指南打开测试邀请，安装 MeetPR。\n安卓：按指南下载安装包；首次安装按系统提示允许安装。\n装好后选择「登录」，输入申请内测时的邮箱和刚设置的密码。不要选「注册」，注册入口是给学员使用的。',
      label: '打开 App 安装指南',
      url: installUrl,
    },
    {
      title: '3. 登录教练网页',
      description:
        '需要在电脑上管理学员、编辑和发布训练计划时，打开下面的登录页，使用同一个邮箱和密码登录。',
      label: '登录教练网页',
      url: loginUrl,
    },
    {
      title: '4. 邀请学员',
      description:
        '打开入驻指南，在「邀请学员」中点击「复制邀请消息」，把整段消息发给学员。如果页面要求登录，仍使用同一个邮箱和密码。\n学员按消息安装 App、注册并提交邀请码后，你在 App「接收」里确认绑定。',
      label: '打开我的邀请指南',
      url: inviteUrl,
    },
  ];
  return sendMail(
    input,
    {
      subject: '欢迎加入 MeetPR 内测',
      text: [
        intro,
        ...steps.map((step) => `${step.title}\n${step.description}\n${step.label}：${step.url}`),
      ].join('\n\n'),
      html: `<p>${escape(intro)}</p>${steps.map((step) => `<h2>${escape(step.title)}</h2><p>${escape(step.description).replace(/\n/g, '<br>')}</p><p><a href="${escape(step.url)}">${escape(step.label)}</a></p>`).join('')}`,
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
