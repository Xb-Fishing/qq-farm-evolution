const { MiniProgramLoginSession } = require("../services/qrlogin");

function validCode(code) {
  return typeof code === "string" && code.length >= 1 && code.length <= 512
    // Reject C0/C1 controls in untrusted login codes.
    // eslint-disable-next-line no-control-regex
    && code.trim().length > 0 && !/[\x00-\x1F\x7F-\x9F]/.test(code);
}

function registerAdminQrLoginRoutes({ app }) {
  let inFlight = 0;
  function bounded(handler) {
    return async (req, res) => {
      if (inFlight >= 4) {
        return res.status(429).json({ ok: false, error: "QR login busy" });
      }
      inFlight++;
      const controller = new AbortController();
      let stop;
      const stopped = new Promise(resolve => { stop = resolve; });
      const active = () => !controller.signal.aborted && !res.destroyed && !res.writableEnded;
      const cancel = () => {
        controller.abort();
        stop();
      };
      const timer = setTimeout(() => {
        if (active()) res.status(504).json({ ok: false, error: "QR login timed out" });
        cancel();
      }, 15000);
      res.once("close", cancel);
      // Keep the slot until the underlying operation settles, even if an adapter
      // ignores abort. Racing only the response must not permit unbounded work.
      const operation = Promise.resolve().then(() => {
        if (active()) return handler(req, res, controller.signal, active);
      }).catch(() => {
        if (active()) res.status(500).json({ ok: false, error: "QR login failed" });
      }).finally(() => { inFlight--; });
      try {
        await Promise.race([operation, stopped]);
      } finally {
        clearTimeout(timer);
        res.removeListener("close", cancel);
      }
    };
  }

  app.post("/api/qr/create", bounded(async (req, res, signal, active) => {
    const data = await MiniProgramLoginSession.requestLoginCode({ signal });
    if (active()) res.json({ ok: true, data });
  }));

  app.post("/api/qr/check", (req, res, next) => {
    if (!validCode((req.body || {}).code)) {
      return res.status(400).json({ ok: false, error: "Invalid code" });
    }
    return check(req, res, next);
  });

  const check = bounded(async (req, res, signal, active) => {
    const status = await MiniProgramLoginSession.queryStatus(req.body.code, { signal });
    if (!active()) return;
    if (status.status === "OK") {
      if (!validCode(status.ticket)) throw new Error("Missing ticket");
      const appId = "1112386029";
      const authCode = await MiniProgramLoginSession.getAuthCode(status.ticket, appId, { signal });
      if (!active()) return;
      if (!validCode(authCode)) throw new Error("Missing authorization code");
        const avatar = status.uin
          ? `https://q1.qlogo.cn/g?b=qq&nk=${  status.uin  }&s=640`
          : "";
      return res.json({
        ok: true,
        data: {
          status: "OK", code: authCode, uin: status.uin || "",
          avatar, nickname: status.nickname || "",
        },
      });
    }
    if (status.status === "Used" || status.status === "Wait") {
      return res.json({ ok: true, data: { status: status.status } });
    }
    throw new Error("QR login failed");
  });
}

module.exports = { registerAdminQrLoginRoutes };
