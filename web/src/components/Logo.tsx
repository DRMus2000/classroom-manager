export function Logo(props: { size?: number }) {
  const size = props.size ?? 32;
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#0e7490" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill="url(#logo-g)" />
      <rect x="9" y="10" width="9" height="6" rx="2" fill="#fff" opacity=".95" />
      <rect x="22" y="10" width="9" height="6" rx="2" fill="#fff" opacity=".6" />
      <rect x="9" y="19" width="9" height="6" rx="2" fill="#fff" opacity=".6" />
      <rect x="22" y="19" width="9" height="6" rx="2" fill="#fff" opacity=".95" />
      <rect x="9" y="28" width="22" height="3" rx="1.5" fill="#fff" opacity=".45" />
    </svg>
  );
}
