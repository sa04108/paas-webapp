import { buildPath } from "../public/app-router.js";

export interface User {
  id: number;
  username: string;
  role: string;
  isAdmin?: boolean;
  mustChangePassword: boolean;
  createdAt?: string;
  lastAccessAt?: string;
}
export interface PortalConfig {
  domain: string;
  appsDomain: string;
  devMode: boolean;
  traefikPort?: number | null;
  limits: { maxAppsPerUser: number; maxTotalApps: number };
}
export interface Service {
  name: string;
  kind?: string;
  status: string;
  health?: string;
  exitCode?: number | null;
}
export interface AppInfo {
  userid: string;
  appname: string;
  domain?: string;
  status: string;
  repoUrl?: string;
  branch?: string;
  detectedRuntime?: {
    name?: string;
    icon?: string;
    displayName?: string;
    dependencies?: { name: string; icon?: string; displayName?: string }[];
  };
  createdAt?: string;
  services?: Service[];
  primaryService?: string;
  redeployRequired?: boolean;
  pendingConfigChanges?: { build: boolean; runtime: boolean };
  activeCustomDomains?: { domain: string }[];
}
export interface Job {
  id: string;
  type: string;
  status: string;
  meta?: { userid?: string; appname?: string; [key: string]: unknown };
  logs?: string[];
  output?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface BuildConfig {
  mode: "auto" | "repository" | "custom" | "railpack";
  dockerfile?: string;
  content?: string;
  config?: string;
}
export interface RuntimeConfig {
  mode: "single" | "compose";
  source?: "inline" | "repository";
  content?: string;
  file?: string;
  webService?: string;
}
export interface Domain {
  id: number;
  domain: string;
  cnameTarget: string;
  status: string;
}
export interface LogEntry {
  id: string;
  timestamp: string;
  service: string;
  stream: string;
  message: string;
}
export type Notice = (
  message: string,
  kind?: "info" | "success" | "error",
) => void;
export const appPath = (userid: string, appname: string) =>
  buildPath("app-detail", { userid, appname });
export const isActiveJob = (job: Job) =>
  job.status === "pending" || job.status === "running";
