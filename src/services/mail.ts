const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

export interface PasswordResetEmailInput {
  apiKey: string;
  from: string;
  to: string;
  code: string;
}

export async function sendPasswordResetEmail(
  input: PasswordResetEmailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = `Your MeetPR password reset code is ${input.code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`;
  const html = `<p>Your MeetPR password reset code is <strong>${input.code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`;
  const response = await fetchImpl(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: 'Your MeetPR password reset code',
      text,
      html,
    }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Resend returned ${String(response.status)}`);
  }
}
