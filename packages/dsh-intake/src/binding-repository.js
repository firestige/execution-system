import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export class IntakeBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = "IntakeBindingError";
    this.code = code;
  }
}

function exact(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "correlation,deliveryBindingIdentity,deliveryId,sessionKey,state,worktree"
    || typeof value.sessionKey !== "string" || value.sessionKey.length === 0
    || typeof value.correlation !== "string" || value.correlation.length === 0
    || typeof value.deliveryId !== "string" || value.deliveryId.length === 0
    || typeof value.deliveryBindingIdentity !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.deliveryBindingIdentity)
    || typeof value.worktree !== "string" || !isAbsolute(value.worktree)
    || !["BOUND", "DETACHED"].includes(value.state)) {
    throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
  }
  return Object.freeze({
    sessionKey: value.sessionKey,
    correlation: value.correlation,
    deliveryId: value.deliveryId,
    deliveryBindingIdentity: value.deliveryBindingIdentity,
    worktree: resolve(value.worktree),
    state: value.state,
  });
}

function legacy(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "correlation,deliveryId,sessionKey,state,worktree"
    || typeof value.sessionKey !== "string" || value.sessionKey.length === 0
    || typeof value.correlation !== "string" || value.correlation.length === 0
    || typeof value.deliveryId !== "string" || value.deliveryId.length === 0
    || typeof value.worktree !== "string" || !isAbsolute(value.worktree)
    || !["BOUND", "DETACHED"].includes(value.state)) {
    throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
  }
  return Object.freeze({ ...value, worktree: resolve(value.worktree) });
}

function validate(bindings) {
  const accepted = bindings.map(exact);
  if (new Set(accepted.map((entry) => entry.sessionKey)).size !== accepted.length
    || new Set(accepted.map((entry) => entry.correlation)).size !== accepted.length
    || new Set(accepted.map((entry) => entry.deliveryId)).size !== accepted.length
    || new Set(accepted.map((entry) => entry.deliveryBindingIdentity)).size !== accepted.length
    || new Set(accepted.map((entry) => entry.worktree)).size !== accepted.length) {
    throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
  }
  return accepted;
}

export class IntakeSessionBindingRepository {
  #bindings = [];
  #started = false;
  constructor(file) {
    if (typeof file !== "string" || !isAbsolute(file)) throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
    this.file = resolve(file);
  }

  async start(inventory = []) {
    if (this.#started) return;
    try {
      const document = JSON.parse(await readFile(this.file, "utf8"));
      if (document === null || typeof document !== "object" || Array.isArray(document)
        || Object.keys(document).sort().join(",") !== "bindings,schemaVersion" || !Array.isArray(document.bindings)
        || !["execution.intake-bindings@1.0.0", "execution.intake-bindings@2.0.0"].includes(document.schemaVersion)) {
        throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
      }
      if (document.schemaVersion === "execution.intake-bindings@2.0.0") {
        this.#bindings = validate(document.bindings);
      } else {
        if (!Array.isArray(inventory)) throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
        this.#bindings = validate(document.bindings.map((candidate) => {
          const entry = legacy(candidate);
          const matches = inventory.filter((item) => item !== null && typeof item === "object"
            && item.deliveryId === entry.deliveryId && typeof item.worktree === "string" && isAbsolute(item.worktree)
            && resolve(item.worktree) === entry.worktree
            && typeof item.deliveryBindingIdentity === "string" && /^sha256:[0-9a-f]{64}$/u.test(item.deliveryBindingIdentity));
          if (matches.length !== 1) throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
          return { ...entry, deliveryBindingIdentity: matches[0].deliveryBindingIdentity };
        }));
        await this.#persist();
      }
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        if (cause instanceof IntakeBindingError) throw cause;
        throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
      }
      this.#bindings = [];
    }
    this.#started = true;
  }

  async claim(input) {
    this.#ready();
    const candidate = exact({ ...input, state: "BOUND" });
    const session = this.#bindings.find((entry) => entry.sessionKey === candidate.sessionKey);
    if (session !== undefined) {
      if (session.deliveryId === candidate.deliveryId && session.correlation === candidate.correlation
        && session.worktree === candidate.worktree && session.deliveryBindingIdentity === candidate.deliveryBindingIdentity) return session;
      if (session.state === "DETACHED" && session.deliveryId === candidate.deliveryId
        && session.worktree === candidate.worktree && session.deliveryBindingIdentity === candidate.deliveryBindingIdentity) {
        this.#bindings.splice(this.#bindings.indexOf(session), 1, candidate);
        await this.#persist();
        return candidate;
      }
      throw new IntakeBindingError("SESSION_INTAKE_BOUND");
    }
    const delivery = this.#bindings.find((entry) => entry.deliveryId === candidate.deliveryId);
    if (delivery?.state === "BOUND") throw new IntakeBindingError("DELIVERY_INTAKE_BOUND");
    if (delivery?.state === "DETACHED") {
      if (delivery.worktree !== candidate.worktree || delivery.deliveryBindingIdentity !== candidate.deliveryBindingIdentity) {
        throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
      }
      this.#bindings.splice(this.#bindings.indexOf(delivery), 1, candidate);
    }
    else this.#bindings.push(candidate);
    await this.#persist();
    return candidate;
  }

  async bySession(sessionKey) {
    this.#ready();
    return this.#bindings.find((entry) => entry.sessionKey === sessionKey);
  }

  async byDelivery(deliveryId) {
    this.#ready();
    return this.#bindings.find((entry) => entry.deliveryId === deliveryId);
  }

  async list() {
    this.#ready();
    return Object.freeze([...this.#bindings]);
  }

  async markDetached(deliveryId) {
    this.#ready();
    const index = this.#bindings.findIndex((entry) => entry.deliveryId === deliveryId);
    if (index === -1 || this.#bindings[index].state === "DETACHED") return;
    this.#bindings.splice(index, 1, Object.freeze({ ...this.#bindings[index], state: "DETACHED" }));
    await this.#persist();
  }

  async detach(deliveryId) {
    this.#ready();
    const index = this.#bindings.findIndex((entry) => entry.deliveryId === deliveryId);
    if (index === -1) return;
    this.#bindings.splice(index, 1);
    await this.#persist();
  }

  #ready() {
    if (!this.#started) throw new IntakeBindingError("INTAKE_BINDING_INVARIANT_VIOLATION");
  }

  async #persist() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const document = { schemaVersion: "execution.intake-bindings@2.0.0", bindings: this.#bindings };
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, this.file);
  }
}
