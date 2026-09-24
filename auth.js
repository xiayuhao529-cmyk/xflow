const $ = (id) => document.getElementById(id);

const el = {
  phoneInput: $("phoneInput"),
  passwordInput: $("passwordInput"),
  loginBtn: $("loginBtn"),
  openRegisterModalBtn: $("openRegisterModalBtn"),
  registerModal: $("registerModal"),
  regPhoneInput: $("regPhoneInput"),
  regPasswordInput: $("regPasswordInput"),
  regCodeInput: $("regCodeInput"),
  sendCodeBtn: $("sendCodeBtn"),
  regCodeStatus: $("regCodeStatus"),
  registerError: $("registerError"),
  confirmRegisterBtn: $("confirmRegisterBtn"),
  cancelRegisterBtn: $("cancelRegisterBtn"),
  openForgotModalBtn: $("openForgotModalBtn"),
  forgotModal: $("forgotModal"),
  forgotError: $("forgotError"),
  forgotPhoneInput: $("forgotPhoneInput"),
  forgotNewPasswordInput: $("forgotNewPasswordInput"),
  forgotCodeInput: $("forgotCodeInput"),
  forgotSendCodeBtn: $("forgotSendCodeBtn"),
  forgotCodeStatus: $("forgotCodeStatus"),
  confirmForgotBtn: $("confirmForgotBtn"),
  cancelForgotBtn: $("cancelForgotBtn"),
  authLog: $("authLog"),
};

function log(msg) {
  el.authLog.textContent = msg;
}

function setHint(node, msg, isError) {
  if (!node) return;
  node.textContent = msg || "";
  node.classList.toggle("error", Boolean(isError));
}

function startCountdown(buttonEl, seconds, baseLabel) {
  if (!buttonEl) return () => {};
  const btn = buttonEl;
  const original = baseLabel || btn.textContent || "发送验证码";
  let left = Math.max(0, Math.floor(Number(seconds) || 0));
  btn.disabled = true;
  btn.textContent = `${original}（${left}s）`;
  const t = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(t);
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
    btn.textContent = `${original}（${left}s）`;
  }, 1000);
  return () => {
    clearInterval(t);
    btn.disabled = false;
    btn.textContent = original;
  };
}

/** 中国大陆手机号：11 位，1 开头，第二位 3–9 */
function isValidCnMobile(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || "").trim());
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) throw new Error(data?.error || text || `HTTP ${resp.status}`);
  return data;
}

function setBusy(busy) {
  el.loginBtn.disabled = busy;
  el.openRegisterModalBtn.disabled = busy;
  el.confirmRegisterBtn.disabled = busy;
  el.sendCodeBtn.disabled = busy;
  el.openForgotModalBtn.disabled = busy;
  el.forgotSendCodeBtn.disabled = busy;
  el.confirmForgotBtn.disabled = busy;
}

function showRegisterModal(show) {
  el.registerModal.classList.toggle("hidden", !show);
  if (show) {
    setHint(el.regCodeStatus, "", false);
    showRegisterError("");
  }
}

function showRegisterError(msg) {
  if (!el.registerError) return;
  if (!msg) {
    el.registerError.classList.add("hidden");
    el.registerError.textContent = "";
    return;
  }
  el.registerError.textContent = msg;
  el.registerError.classList.remove("hidden");
}

function showForgotModal(show) {
  el.forgotModal.classList.toggle("hidden", !show);
  if (!show) {
    el.forgotError.classList.add("hidden");
    el.forgotError.textContent = "";
    setHint(el.forgotCodeStatus, "", false);
  }
}

function showForgotError(msg) {
  if (!msg) {
    el.forgotError.classList.add("hidden");
    el.forgotError.textContent = "";
    return;
  }
  el.forgotError.textContent = msg;
  el.forgotError.classList.remove("hidden");
}

async function doLogin() {
  const phone = (el.phoneInput.value || "").trim();
  const password = (el.passwordInput.value || "").trim();
  if (!phone) return log("请输入手机号");
  if (!isValidCnMobile(phone)) return log("请输入正确的11位中国大陆手机号");
  if (!password) return log("请输入密码");
  log("正在登录...");
  setBusy(true);
  try {
    await postJson("/api/auth/login", { phone, password });
    window.location.href = "/workspace.html";
  } catch (e) {
    log(`失败：${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function doRegister() {
  const phone = (el.regPhoneInput.value || "").trim();
  const password = (el.regPasswordInput.value || "").trim();
  const verifyCode = (el.regCodeInput.value || "").trim();
  if (!phone) return log("注册失败：请输入手机号");
  if (!isValidCnMobile(phone)) return log("注册失败：请输入正确的11位中国大陆手机号");
  if (!password || password.length < 6) return log("注册失败：密码至少6位");
  if (!verifyCode) {
    showRegisterError("请输入短信验证码");
    return;
  }
  log("正在注册...");
  setBusy(true);
  showRegisterError("");
  try {
    await postJson("/api/auth/register", { phone, password, verifyCode });
    showRegisterModal(false);
    el.phoneInput.value = phone;
    el.passwordInput.value = password;
    log("注册成功，已自动登录，正在进入工作台...");
    window.location.href = "/workspace.html";
  } catch (e) {
    // 注册失败信息优先显示在弹窗内
    showRegisterError(e.message || "注册失败");
    log(`注册失败：${e.message}`);
  } finally {
    setBusy(false);
  }
}

el.loginBtn.addEventListener("click", doLogin);
el.openRegisterModalBtn.addEventListener("click", () => showRegisterModal(true));
el.cancelRegisterBtn.addEventListener("click", () => showRegisterModal(false));
el.confirmRegisterBtn.addEventListener("click", doRegister);
el.sendCodeBtn.addEventListener("click", async () => {
  const phone = (el.regPhoneInput.value || "").trim();
  if (!phone) return log("请先输入注册手机号");
  if (!isValidCnMobile(phone)) return log("请先输入正确的11位中国大陆手机号");
  setHint(el.regCodeStatus, "正在发送验证码…", false);
  try {
    await postJson("/api/auth/verify-sms", { phone, purpose: "register" });
    setHint(el.regCodeStatus, "验证码已发送（5分钟内有效），请查收短信。", false);
    startCountdown(el.sendCodeBtn, 60, "重新发送");
  } catch (e) {
    setHint(el.regCodeStatus, `发送失败：${e.message}`, true);
  }
});

el.openForgotModalBtn.addEventListener("click", () => {
  showForgotError("");
  el.forgotPhoneInput.value = el.phoneInput.value || "";
  el.forgotNewPasswordInput.value = "";
  el.forgotCodeInput.value = "";
  showForgotModal(true);
});
el.cancelForgotBtn.addEventListener("click", () => showForgotModal(false));
el.forgotModal.addEventListener("click", (e) => {
  if (e.target === el.forgotModal) showForgotModal(false);
});

el.forgotSendCodeBtn.addEventListener("click", async () => {
  const phone = (el.forgotPhoneInput.value || "").trim();
  if (!phone) return showForgotError("请先输入手机号");
  if (!isValidCnMobile(phone)) return showForgotError("请输入正确的11位中国大陆手机号");
  setHint(el.forgotCodeStatus, "正在发送验证码…", false);
  try {
    await postJson("/api/auth/verify-sms", { phone, purpose: "reset" });
    showForgotError("");
    setHint(el.forgotCodeStatus, "验证码已发送（5分钟内有效），请查收短信。", false);
    startCountdown(el.forgotSendCodeBtn, 60, "重新发送");
  } catch (e) {
    setHint(el.forgotCodeStatus, `发送失败：${e.message}`, true);
  }
});

el.confirmForgotBtn.addEventListener("click", async () => {
  const phone = (el.forgotPhoneInput.value || "").trim();
  const newPassword = (el.forgotNewPasswordInput.value || "").trim();
  const verifyCode = (el.forgotCodeInput.value || "").trim();
  if (!phone) return showForgotError("请输入手机号");
  if (!isValidCnMobile(phone)) return showForgotError("请输入正确的11位中国大陆手机号");
  if (!newPassword || newPassword.length < 6) return showForgotError("新密码至少6位");
  if (!verifyCode) return showForgotError("请输入验证码（当前为占位）");
  setBusy(true);
  showForgotError("");
  log("正在重置密码...");
  try {
    await postJson("/api/auth/reset-password", { phone, newPassword, verifyCode });
    showForgotModal(false);
    el.phoneInput.value = phone;
    el.passwordInput.value = newPassword;
    log("密码已重置，请使用新密码登录。");
  } catch (e) {
    showForgotError(`重置失败：${e.message}`);
  } finally {
    setBusy(false);
  }
});

