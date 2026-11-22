// WP1.1: behaviour unchanged from qingzhou/src/auth-pages.js, typed.
import { env } from "../env.js";

/** Absolute in-app URL; "/task/..." in production, "/..." for local dev. */
function appUrl(path = "") {
  return `${env.baseUrlPath}${path}`;
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} · UpLoop</title>
<style>
  body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;align-items:safe center;justify-content:safe center;box-sizing:border-box;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:#f5f5f5;color:#262626;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
  main{box-sizing:border-box;flex:0 0 auto;align-self:center;width:min(100%,400px);height:auto;margin:0;padding:22px 20px 20px;background:#fff;border:1px solid #e5e5e5;border-radius:20px;box-shadow:0 16px 40px rgba(0,0,0,.055)}
  h1{margin:0;font-size:22px;letter-spacing:-.04em}
  p{margin:10px 0 0;color:#737373;font-size:14px;line-height:1.5}
  form{display:grid;gap:12px;margin-top:18px}
  label{display:grid;gap:6px;color:#737373;font-size:13px}
  input{width:100%;box-sizing:border-box;padding:10px 0;color:#262626;background:transparent;border:0;border-bottom:1px solid #e5e5e5;outline:0;font:inherit}
  button,a.button{display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:11px 14px;color:#262626;background:#f5f5f5;border:1px solid #dedede;border-radius:12px;font:inherit;text-align:center;text-decoration:none}
  button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #525252;outline-offset:3px}
  .status{min-height:18px;color:#525252}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function verifySuccessPage() {
  return page(
    "邮箱验证成功",
    `
    <h1>邮箱验证成功</h1>
    <p>起一个名字，它会显示在右上角。</p>
    <form id="nameForm">
      <label>用户名<input id="username" maxlength="20" required placeholder="怎么称呼你" autocomplete="nickname"></label>
      <button type="submit">完成</button>
      <p id="status" class="status"></p>
    </form>
    <script>
      document.getElementById('nameForm').onsubmit = async (event) => {
        event.preventDefault();
        const status = document.getElementById('status');
        const username = document.getElementById('username').value.trim();
        const response = await fetch('${appUrl("api/auth/username")}', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { status.textContent = data.error || '保存失败'; return; }
        location.href = '${appUrl()}';
      };
    </script>
  `,
  );
}

export function verifyErrorPage(message: string) {
  return page("验证失败", `<h1>验证失败</h1><p>${message}</p><p><a class="button" href="${appUrl("?login=1")}">返回登录</a></p>`);
}

export function resetPasswordPage() {
  return page(
    "重置密码",
    `
    <h1>重置密码</h1>
    <p>设置一个新密码，至少 8 位。完成后会回到登录。</p>
    <form id="resetForm">
      <label>新密码<input id="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>再输入一次<input id="confirm" type="password" minlength="8" required autocomplete="new-password"></label>
      <button type="submit">更新密码</button>
      <p id="status" class="status"></p>
    </form>
    <script>
      const params = new URLSearchParams(location.search);
      document.getElementById('resetForm').onsubmit = async (event) => {
        event.preventDefault();
        const status = document.getElementById('status');
        const password = document.getElementById('password').value;
        const confirm = document.getElementById('confirm').value;
        if (password !== confirm) { status.textContent = '两次密码不一致'; return; }
        const response = await fetch('${appUrl("api/auth/reset-password")}', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: params.get('token') || '', password })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { status.textContent = data.error || '重置失败'; return; }
        location.href = '${appUrl("?login=1")}';
      };
    </script>
  `,
  );
}
