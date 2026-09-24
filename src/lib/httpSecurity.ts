export function sessionCookieOptions(env: NodeJS.ProcessEnv = process.env): {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: env['HTTPS_ENABLED'] === 'true',
  };
}

/** 只信任明确配置的反向代理跳数。未配置时使用直连地址。 */
export function trustProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean | ((address: string, hop: number) => boolean) {
  const raw = env['TRUST_PROXY']?.trim() ?? '';
  if (raw === '' || raw === 'false' || raw === '0') return false;
  const hops = raw === 'true' ? 1 : Number(raw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 5) return false;
  return (_address, hop) => hop < hops;
}
