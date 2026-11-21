# 293 — /register + /set-password 邮件注册与设密码 (before/after)

after  = 598d871d700ee845a248c2b90c3426e0404e1897 (PR #293, head 未变)
before = eecf253af9adcdc37750d50286d3e9437a7f18f0 (PR base / cut-from)

## 每臂来源（逐字）
两臂都是**真 Flask**（`python3.11 -m openteamily.server`），页面 HTML/CSS/JS 与表单校验全是页面自身代码，
未做任何 `page.route` 回放。after 臂额外带 `--email-registration --smtp-host 127.0.0.1 --smtp-port 2525
--mail-from admin@example.test`，本机起一个真的 SMTP+STARTTLS sink（`notes/tmp/smtp_sink.py`，自签证书），
所以 `register-link-sent` 那一帧是真 200，不是回放：发信真的走了 SMTP，sink 里收到 4 封。
两臂都以 `--anonymous` 打开（登录页/注册页本来就是未登录面），`--allow-status 401,404` 记录的是
`/set-password?token=…` 这类无 token/坏 token 的真状态码。**没有注入。**

## 状态与矩阵
- 路由：`/register`、`/set-password?token=AAAA…`（41 位占位 token）
- 状态：`default` / `register-link-sent` / `register-code-invalid` / `register-code-sent` /
  `password-invalid-token` / `password-mismatch`
- 矩阵：390x844 + 768x1024 + 1440x900 × zh-CN,en × light,dark → 296 帧
  （768 列 96 帧；en 列 144 帧）

## 语言
页面没有 en 文案：en 列只是 `documentElement.lang` 被切到 `en`，界面仍是中文。不当英文翻译证据。

## 读数
`report.json` 每帧含 URL、状态码、`#register-*` / `#set-password-*` 选择器的 probe 结果与 console；
`diff.json` 是两臂同格的像素差。
