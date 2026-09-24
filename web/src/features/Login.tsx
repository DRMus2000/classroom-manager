import { useState } from 'react';
import { api, describeError } from '../lib/api';
import type { MeDto } from '../lib/types';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';

export function Login(props: { onSignedIn: (me: MeDto) => void; notice?: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(props.notice ?? '');
  const [pending, setPending] = useState(false);

  async function submit() {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const me = await api<MeDto>('/auth/login', { method: 'POST', body: { username, password } });
      props.onSignedIn(me);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login">
      <section className="login-art" aria-hidden="true">
        <div className="login-art-inner">
          <Logo size={44} />
          <h1>电脑室积分</h1>
          <p>座位、记分、卫生与课堂展示，一台设备操作，所有屏幕同步。</p>
          <div className="login-room">
            {[0, 1].map((desk) => (
              <div key={desk} className="login-desk">
                {[0, 1].map((col) => (
                  <div key={col} className="login-col">
                    {Array.from({ length: 7 }, (_, i) => (
                      <span key={i} style={{ animationDelay: `${i * 450}ms` }} />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="login-panel">
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="login-mobile-brand">
            <Logo size={36} />
            <strong>电脑室积分</strong>
          </div>
          <h2>教师登录</h2>
          <p className="muted">学生无需登录。展示屏请使用已登录设备进入「展示」。</p>
          <label className="field">
            <span>用户名</span>
            <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>密码</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending || !username || !password}>
            {pending ? '正在登录…' : '登录'}
            {pending ? null : <Icon name="arrowRight" size={17} />}
          </button>
        </form>
      </section>
    </main>
  );
}
