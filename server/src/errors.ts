export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function badRequest(code: string, message: string) {
  return new HttpError(400, code, message);
}

export function onboardingRequired() {
  return new HttpError(403, "onboarding_required", "先完成开始之前的几件事");
}

export function consentRequired() {
  return new HttpError(403, "cloud_consent_required", "还没有同意云端处理，对话先不能用");
}

export function quotaExceeded() {
  return new HttpError(403, "quota", "本月额度已用完，对话已暂停");
}
