function getClientIp(req) {
  const cfIp = req.headers["cf-connecting-ip"];
  if (cfIp) return cfIp.trim();

  const realIp = req.headers["x-real-ip"];
  if (realIp) return realIp.trim();

  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    const candidates = forwardedFor
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (candidates.length > 0) return candidates[0];
  }

  if (req.ip && req.ip !== "::1" && req.ip !== "::ffff:127.0.0.1")
    return req.ip;

  const remoteAddress =
    req.connection?.remoteAddress || req.socket?.remoteAddress;
  if (remoteAddress?.startsWith("::ffff:")) return remoteAddress.substring(7);
  return remoteAddress || "unknown";
}

function registerAdminAuthRoutes({
  app,
  logger,
  userStore,
  requireAdminToken,
  createAdminSession,
}) {
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    const ip = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "";

    if (!username || !password) {
      return res.status(401).json({ ok: false, error: "请输入用户名和密码" });
    }

    const validationResult = userStore.validateUser(username, password, ip);
    if (validationResult && validationResult.error) {
      const status =
        validationResult.error === "rate_limit"
          ? 429
          : validationResult.error === "locked"
            ? 423
            : 401;
      logger.warn("登录失败", {
        username,
        error: validationResult.error,
        ip,
        message: validationResult.message,
      });
      userStore.addLoginLog(
        "login_failed",
        username,
        validationResult.error,
        ip,
        userAgent,
      );
      return res.status(status).json({
        ok: false,
        error: validationResult.message,
        errorType: validationResult.error,
        remainingMs: validationResult.remainingMs,
      });
    }

    if (!validationResult) {
      logger.warn("登录失败", {
        username,
        ip,
        reason: "invalid_credentials",
      });
      userStore.addLoginLog(
        "login_failed",
        username,
        "invalid_credentials",
        ip,
        userAgent,
      );
      return res.status(401).json({ ok: false, error: "用户名或密码错误" });
    }

    if (!["admin", "super_admin"].includes(validationResult.role)) {
      return res.status(401).json({ ok: false, error: "用户名或密码错误" });
    }
    const token = createAdminSession(validationResult);
    if (!token) return res.status(401).json({ ok: false, error: "用户名或密码错误" });
    userStore.addLoginLog("login_success", username, null, ip, userAgent);
    return res.json({
      ok: true,
      data: {
        token,
        role: validationResult.role,
        card: validationResult.card,
        accountLimit:
          validationResult.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
        user: { username: validationResult.username },
        mustChangePassword: validationResult.mustChangePassword || false,
      },
    });
  });

  app.post("/api/user/change-password", requireAdminToken, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    const username = req.currentUser?.username;
    if (!username) {
      return res.status(401).json({ ok: false, error: "未登录" });
    }
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: "请提供原密码和新密码" });
    }

    const result = userStore.changePassword(username, oldPassword, newPassword);
    res.json(result);
  });
}

module.exports = { registerAdminAuthRoutes };
