export const UI_LINE = '━━━━━━━━━━━━━━━━━━━━';
export const UI_THIN_LINE = '────────────';

export function uiTitle(icon, text) {
  return `${icon} ${text}`;
}

export function uiKV(icon, label, value) {
  return `${icon} ${label} | ${value}`;
}

export function uiBullet(icon, text) {
  return `${icon} ${text}`;
}

export function uiCommand(command, description) {
  return `• ${command} | ${description}`;
}

export function uiSection(icon, title) {
  return `${icon} ${title}`;
}
