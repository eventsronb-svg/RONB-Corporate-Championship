export interface ConfirmationTeam {
  teamName: string;
  sportName: string;
  players: string[];
}
export interface ConfirmationEvent {
  title: string;
  venue: string;
  startDate: string;
  endDate: string;
}
export interface ConfirmationEmailInput {
  companyName: string;
  orderId: string;
  amount: string;
  teams: ConfirmationTeam[];
  event: ConfirmationEvent | null;
  logoUrl: string;
  siteUrl: string;
  supportEmail: string;
}
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const PAPER = '#fbf9f9';
const INK = '#252020';
const MUTED = '#5c5656';
const ACCENT = '#c21725';
const RULE = '#cec9c9';
const FONT = "Arial, 'Helvetica Neue', Helvetica, sans-serif";
export function confirmationEmail(input: ConfirmationEmailInput): RenderedEmail {
  const company = input.companyName || 'there';
  const event = input.event;
  const intro = [
    'Warm greetings from RONB Events!',
    'We are delighted to welcome you to the RONB Corporate Championship 2026. Thank you for being part of this exciting event, where we look forward to bringing together corporate teams for a memorable experience filled with competition, camaraderie, and team spirit.',
    'Your participation means a great deal to us, and we are excited to have you join us for what promises to be an engaging and enjoyable championship.',
    'We look forward to welcoming you and your team to the RONB Corporate Championship 2026.',
  ];
  const detailLines = [
    `Order: ${input.orderId}`,
    `Amount paid: ${input.amount}`,
    event ? `Venue: ${event.venue}` : '',
    event ? `Dates: ${event.startDate} - ${event.endDate}` : '',
  ].filter(Boolean);
  const teamBlocks = input.teams.map(
    (team) =>
      `${team.teamName} — ${team.sportName}\nPlayers: ${team.players.length ? team.players.join(', ') : 'To be confirmed'}`,
  );
  const text = [
    `Dear ${company},`,
    '',
    ...intro.flatMap((line) => [line, '']),
    'Warm regards,',
    'RONB Events Team',
    '',
    'Registration details',
    ...detailLines,
    '',
    ...teamBlocks.flatMap((block) => [block, '']),
    `View your registration: ${input.siteUrl}/register`,
    input.supportEmail ? `Questions? Reply to ${input.supportEmail}` : '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
  const introHtml = intro
    .map(
      (line) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${INK};">${escapeHtml(line)}</p>`,
    )
    .join('');
  const detailRows = detailLines
    .map(
      (line) =>
        `<tr><td style="padding:4px 0;font-size:15px;line-height:1.5;color:${INK};">${escapeHtml(line)}</td></tr>`,
    )
    .join('');
  const teamsHtml = input.teams
    .map((team) => {
      const players = team.players.length ? team.players.join(', ') : 'To be confirmed';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border-collapse:collapse;">
        <tr><td style="padding:12px 16px;background:#ffffff;border:1px solid ${RULE};border-radius:10px;">
          <p style="margin:0;font-size:16px;font-weight:bold;color:${INK};">${escapeHtml(team.teamName)}</p>
          <p style="margin:2px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:${ACCENT};">${escapeHtml(team.sportName)}</p>
          <p style="margin:0;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(players)}</p>
        </td></tr>
      </table>`;
    })
    .join('');
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:${PAPER};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${PAPER};border:1px solid ${RULE};border-radius:16px;overflow:hidden;">
            <tr>
              <td align="center" style="padding:32px 32px 8px;">
                <img src="${escapeHtml(input.logoUrl)}" alt="RONB Events" width="150" style="display:block;width:150px;max-width:150px;height:auto;border:0;" />
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 0;">
                <p style="margin:0 0 20px;font-size:17px;line-height:1.6;color:${INK};">Dear ${escapeHtml(company)},</p>
                ${introHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${PAPER};border:1px solid ${RULE};border-radius:12px;">
                  <tr>
                    <td style="padding:20px 20px 12px;">
                      <p style="margin:0 0 10px;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:1.5px;color:${ACCENT};">Registration details</p>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${detailRows}</table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 20px 20px;">${teamsHtml}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 32px 8px;">
                <a href="${escapeHtml(input.siteUrl)}/register" style="display:inline-block;padding:14px 28px;background:${ACCENT};color:#fffefe;font-size:16px;font-weight:bold;text-decoration:none;border-radius:100px;">View your registration</a>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 32px;">
                <p style="margin:0 0 4px;font-size:16px;line-height:1.6;color:${INK};">Warm regards,</p>
                <p style="margin:0;font-size:16px;line-height:1.6;font-weight:bold;color:${INK};">RONB Events Team</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;border-top:1px solid ${RULE};">
                <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};text-align:center;">
                  RONB Events · <a href="${escapeHtml(input.siteUrl)}" style="color:${MUTED};">ronbevents.com</a>${
                    input.supportEmail
                      ? ` · <a href="mailto:${escapeHtml(input.supportEmail)}" style="color:${MUTED};">${escapeHtml(input.supportEmail)}</a>`
                      : ''
                  }
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return {
    subject: `Welcome to ${event?.title ?? 'the RONB Corporate Championship 2026'}`,
    text,
    html,
  };
}
