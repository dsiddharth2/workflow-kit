import fs from 'node:fs/promises';
import path from 'node:path';
import { memberIsPresent, toolResultLooksFailed, toolText } from './fleet-text.mjs';

// The single owner of member lifecycle. Nothing else in the kit may call
// registerMember, removeMember, or provisionLlmAuth.
export class MemberManager {
  #fleetApi;
  #oauthToken;
  #warnedNoAuth = false;

  constructor(fleetApi, { oauthToken } = {}) {
    if (!fleetApi) throw new Error('MemberManager requires fleetApi');
    this.#fleetApi = fleetApi;
    this.#oauthToken = oauthToken ?? null;
  }

  async provisionPair(prefix, workRoot) {
    const doer = { name: `${prefix}-DOER`, folder: path.join(workRoot, 'doer') };
    const reviewer = { name: `${prefix}-REVIEWER`, folder: path.join(workRoot, 'reviewer') };

    try {
      await this.#ensureRegistered(doer);
      await this.#ensureRegistered(reviewer);
      await this.#provisionAuth(doer.name);
      await this.#provisionAuth(reviewer.name);
      return { doer, reviewer };
    } catch (err) {
      // Unregister anyone who made it onto the Fleet, and drop half-created
      // folders so a failed provision cannot fill tmpdir.
      await this.teardownPair(prefix, workRoot);
      throw err;
    }
  }

  async teardownPair(prefix, workRoot) {
    await this.#tryRemove(`${prefix}-DOER`);
    await this.#tryRemove(`${prefix}-REVIEWER`);
    await fs.rm(workRoot, { recursive: true, force: true });
  }

  // Fails on the first problem. A pool that started with a missing member
  // would fail later inside a run with an error that looks unrelated.
  async provisionRoster(roster) {
    for (const worker of roster) {
      await this.#ensureRegistered(worker.doer);
      await this.#ensureRegistered(worker.reviewer);
      await this.#provisionAuth(worker.doer.name);
      await this.#provisionAuth(worker.reviewer.name);
    }
  }

  async #ensureRegistered({ name, folder }) {
    await fs.mkdir(folder, { recursive: true });
    if (await this.#isPresent(name)) return;

    const result = await this.#fleetApi.registerMember({
      friendly_name: name,
      work_folder: folder,
      member_type: 'local',
    });
    if (!toolResultLooksFailed(result)) return;

    // Fleet may report an already-present member as an error; re-check before failing.
    if (await this.#isPresent(name)) return;
    throw new Error(`register_member failed for ${name}: ${toolText(result)}`);
  }

  async #isPresent(name) {
    return memberIsPresent(toolText(await this.#fleetApi.listMembers({})), name);
  }

  async #provisionAuth(name) {
    if (!this.#oauthToken) {
      if (!this.#warnedNoAuth) {
        this.#warnedNoAuth = true;
        console.warn('[member-manager] no OAuth token; members cannot run agent prompts');
      }
      return;
    }
    if (typeof this.#fleetApi.provisionLlmAuth !== 'function') {
      if (!this.#warnedNoAuth) {
        this.#warnedNoAuth = true;
        console.warn('[member-manager] Fleet exposes no provision_llm_auth; members cannot run agent prompts');
      }
      return;
    }
    try {
      const result = await this.#fleetApi.provisionLlmAuth({ member_name: name });
      if (toolResultLooksFailed(result)) {
        console.warn(`[member-manager] OAuth provisioning failed for ${name}: ${toolText(result)}`);
      }
    } catch (err) {
      console.warn(`[member-manager] OAuth provisioning failed for ${name}: ${err?.message ?? err}`);
    }
  }

  // An orphaned registration whose folder is gone is harmless; a thrown
  // teardown that wedges a release is not.
  async #tryRemove(name) {
    if (typeof this.#fleetApi.removeMember !== 'function') return;
    try {
      await this.#fleetApi.removeMember({ member_name: name });
    } catch (err) {
      console.warn(`[member-manager] remove_member failed for ${name}: ${err?.message ?? err}`);
    }
  }
}
