import axios from "axios";

const rawBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api";
export const API_BASE_URL = rawBaseUrl.replace(/\/$/, "");
const SESSION_STORAGE_KEY = "nexabank_session_id";

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getNexaBankSessionId(): string {
  if (typeof window === "undefined") return "";

  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;

  const sessionId = makeSessionId();
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  return sessionId;
}

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

apiClient.interceptors.request.use((config) => {
  const sessionId = getNexaBankSessionId();
  if (sessionId) {
    config.headers = config.headers ?? {};
    config.headers["x-session-id"] = sessionId;
  }
  return config;
});
