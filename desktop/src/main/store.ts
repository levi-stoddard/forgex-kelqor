import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { z } from "zod";

// Per-user settings and the session token, in the app's own data folder. The token is encrypted with Windows'
// data protection (safeStorage); if that isn't available it is kept in memory only and never written to disk.

const Settings = z.object({
  notificationsEnabled: z.boolean().default(false),
  // Start the local backend when KELQOR opens (and stop it on exit).
  autoStartBackend: z.boolean().default(true),
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.literal("operator") }).nullable().default(null),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().default(null),
  maximized: z.boolean().default(false),
});
export type Settings = z.infer<typeof Settings>;

export class Store {
  readonly dir = app.getPath("userData");
  private readonly settingsFile = path.join(this.dir, "settings.json");
  private readonly tokenFile = path.join(this.dir, "session.bin");
  private memoryToken: string | null = null;
  settings: Settings;

  constructor() {
    this.settings = this.read();
  }

  private read(): Settings {
    try {
      return Settings.parse(JSON.parse(fs.readFileSync(this.settingsFile, "utf8")));
    } catch {
      return Settings.parse({});
    }
  }

  update(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  /** True when the token can be stored encrypted (Windows data protection is available once the app is ready). */
  get tokenProtected(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  getToken(): string | null {
    if (this.memoryToken) return this.memoryToken;
    if (!this.tokenProtected || !fs.existsSync(this.tokenFile)) return null;
    try {
      this.memoryToken = safeStorage.decryptString(fs.readFileSync(this.tokenFile));
      return this.memoryToken;
    } catch {
      return null;
    }
  }

  setToken(token: string): void {
    this.memoryToken = token;
    if (!this.tokenProtected) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.tokenFile, safeStorage.encryptString(token));
  }

  clearToken(): void {
    this.memoryToken = null;
    fs.rmSync(this.tokenFile, { force: true });
  }
}
