import { orderedMemberAccounts } from "./member-order.js";

const elements = {
  serviceState: document.querySelector("#service-state"),
  serviceStateText: document.querySelector("#service-state-text"),
  updated: document.querySelector("#updated"),
  accountCount: document.querySelector("#account-count"),
  endpointCount: document.querySelector("#endpoint-count"),
  apiKeyCount: document.querySelector("#api-key-count"),
  schemaVersion: document.querySelector("#schema-version"),
  accountList: document.querySelector("#account-list"),
  apiKeyList: document.querySelector("#api-key-list"),
  refresh: document.querySelector("#refresh"),
  form: document.querySelector("#import-form"),
  importButton: document.querySelector("#import-button"),
  formMessage: document.querySelector("#form-message"),
  label: document.querySelector("#label"),
  content: document.querySelector("#content"),
  deviceLoginForm: document.querySelector("#device-login-form"),
  deviceLoginLabel: document.querySelector("#device-login-label"),
  deviceLoginButton: document.querySelector("#device-login-button"),
  deviceLoginMessage: document.querySelector("#device-login-message"),
  deviceLoginDialog: document.querySelector("#device-login-dialog"),
  deviceLoginDialogClose: document.querySelector("#device-login-dialog-close"),
  deviceLoginCode: document.querySelector("#device-login-code"),
  deviceLoginOpen: document.querySelector("#device-login-open"),
  deviceLoginCopy: document.querySelector("#device-login-copy"),
  deviceLoginStatus: document.querySelector("#device-login-status"),
  deviceLoginCheck: document.querySelector("#device-login-check"),
  keyForm: document.querySelector("#key-form"),
  keyLabel: document.querySelector("#key-label"),
  keyExpiry: document.querySelector("#key-expiry"),
  keyEndpoint: document.querySelector("#key-endpoint"),
  keyIpAllowlist: document.querySelector("#key-ip-allowlist"),
  createKeyButton: document.querySelector("#create-key-button"),
  keyFormMessage: document.querySelector("#key-form-message"),
  keyDialog: document.querySelector("#key-dialog"),
  keyValue: document.querySelector("#key-value"),
  copyKey: document.querySelector("#copy-key"),
  dialogClose: document.querySelector("#dialog-close"),
  keyEditDialog: document.querySelector("#key-edit-dialog"),
  keyEditDialogClose: document.querySelector("#key-edit-dialog-close"),
  keyEditForm: document.querySelector("#key-edit-form"),
  keyEditLabel: document.querySelector("#key-edit-label"),
  keyEditEndpoint: document.querySelector("#key-edit-endpoint"),
  keyEditIpAllowlist: document.querySelector("#key-edit-ip-allowlist"),
  keyEditExpiry: document.querySelector("#key-edit-expiry"),
  keyEditSaveButton: document.querySelector("#key-edit-save-button"),
  keyEditMessage: document.querySelector("#key-edit-message"),
  accessIdentity: document.querySelector("#access-identity"),
  accountDialog: document.querySelector("#account-dialog"),
  accountDialogClose: document.querySelector("#account-dialog-close"),
  accountEditForm: document.querySelector("#account-edit-form"),
  accountEditLabel: document.querySelector("#account-edit-label"),
  accountEditCap: document.querySelector("#account-edit-cap"),
  accountSaveButton: document.querySelector("#account-save-button"),
  accountEditMessage: document.querySelector("#account-edit-message"),
  policyForm: document.querySelector("#policy-form"),
  policyName: document.querySelector("#policy-name"),
  policyStrategy: document.querySelector("#policy-strategy"),
  policyMembers: document.querySelector("#policy-members"),
  policyCreateButton: document.querySelector("#policy-create-button"),
  policyMessage: document.querySelector("#policy-message"),
  policyGroupList: document.querySelector("#policy-group-list"),
  endpointForm: document.querySelector("#endpoint-form"),
  endpointName: document.querySelector("#endpoint-name"),
  endpointGroup: document.querySelector("#endpoint-group"),
  endpointCreateButton: document.querySelector("#endpoint-create-button"),
  endpointMessage: document.querySelector("#endpoint-message"),
  endpointList: document.querySelector("#endpoint-list"),
  configEndpoint: document.querySelector("#config-endpoint"),
  configKey: document.querySelector("#config-key"),
  configSnippet: document.querySelector("#config-snippet"),
  copyConfig: document.querySelector("#copy-config"),
  clearConfig: document.querySelector("#clear-config"),
  configMessage: document.querySelector("#config-message")
};

let editingAccountId = "";
let editingApiKeyId = "";
let availableEndpoints = [];
let proxyBase = "";
let memberChoiceSequence = 0;
let deviceLoginId = "";
let deviceLoginTimer = 0;
let deviceLoginPolling = false;

async function api(path, init) {
  const response = await fetch(path, { credentials: "include", ...init });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || response.statusText || "Request failed");
  return data;
}

function ipAllowlistInput(value) {
  return value.trim() ? value.trim().split(/[\s,]+/).filter(Boolean) : [];
}

function renderApiKeys(apiKeys) {
  elements.apiKeyList.replaceChildren();
  if (apiKeys.length === 0) {
    elements.apiKeyList.append(emptyState("No Proxy keys", "Clients cannot use the Proxy until you create one."));
    return;
  }

  for (const key of apiKeys) {
    const row = document.createElement("article");
    row.className = "key-row";
    const details = document.createElement("div");
    details.className = "key-details";
    const label = document.createElement("strong");
    label.textContent = key.label;
    const meta = document.createElement("span");
    const scope = key.endpoints.length === 0 ? "all endpoints" : key.endpoints.join(", ");
    const expiry = key.expiresAt ? `expires ${new Date(key.expiresAt).toLocaleDateString()}` : "no expiry";
    const ipScope = key.ipAllowlist.length === 0 ? "any IP" : `${key.ipAllowlist.length} IP rule${key.ipAllowlist.length === 1 ? "" : "s"}`;
    meta.textContent = `••••${key.keyHint} · ${scope} · ${ipScope} · ${expiry}`;
    if (key.ipAllowlist.length > 0) meta.title = key.ipAllowlist.join("\n");
    details.append(label, meta);

    const actions = document.createElement("div");
    actions.className = "key-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "regenerate-button";
    edit.textContent = "Edit";
    const regenerate = document.createElement("button");
    regenerate.type = "button";
    regenerate.className = "regenerate-button";
    regenerate.textContent = "Regenerate";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "revoke-button";
    revoke.textContent = "Revoke";
    edit.addEventListener("click", () => {
      editingApiKeyId = key.id;
      elements.keyEditLabel.value = key.label;
      elements.keyEditIpAllowlist.value = key.ipAllowlist.join(", ");
      elements.keyEditExpiry.value = "__keep__";
      elements.keyEditMessage.textContent = "";
      populateKeyEditScope(key.endpoints);
      elements.keyEditDialog.showModal();
    });
    regenerate.addEventListener("click", async () => {
      if (!confirm(`Regenerate Proxy key “${key.label}”? The current key will stop authenticating immediately.`)) return;
      regenerate.disabled = true;
      revoke.disabled = true;
      try {
        const result = await api(`/admin/api/api-keys/${encodeURIComponent(key.id)}/regenerate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: key.keyVersion })
        });
        showNewKey(result.apiKey);
        await load();
      } catch (error) {
        elements.keyFormMessage.className = "form-message error";
        elements.keyFormMessage.textContent = error.message;
        regenerate.disabled = false;
        revoke.disabled = false;
      }
    });
    revoke.addEventListener("click", async () => {
      if (!confirm(`Revoke Proxy key “${key.label}”? New requests and reconnects will stop authenticating.`)) return;
      revoke.disabled = true;
      try {
        await api(`/admin/api/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
        await load();
      } catch (error) {
        elements.keyFormMessage.className = "form-message error";
        elements.keyFormMessage.textContent = error.message;
        revoke.disabled = false;
      }
    });
    actions.append(edit, regenerate, revoke);
    row.append(details, actions);
    elements.apiKeyList.append(row);
  }
}

function populateKeyEditScope(scope) {
  elements.keyEditEndpoint.replaceChildren();
  if (scope.length > 1) {
    const keep = document.createElement("option");
    keep.value = "__keep__";
    keep.textContent = `Keep current scope (${scope.length} endpoints)`;
    elements.keyEditEndpoint.append(keep);
  }
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All endpoints";
  all.selected = scope.length === 0;
  elements.keyEditEndpoint.append(all);
  for (const endpoint of availableEndpoints) {
    const option = document.createElement("option");
    option.value = endpoint.name;
    option.textContent = endpoint.name;
    option.selected = scope.length === 1 && scope[0] === endpoint.name;
    elements.keyEditEndpoint.append(option);
  }
}

function showNewKey(apiKey) {
  elements.keyValue.textContent = apiKey;
  elements.copyKey.textContent = "Copy API key";
  elements.keyDialog.showModal();
}

function accountStateClass(state) {
  if (state === "ok") return "pill ok";
  if (["revoked", "dead", "expired", "disabled"].includes(state)) return "pill bad";
  if (["cooldown", "quota_exhausted"].includes(state)) return "pill warn";
  return "pill";
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Not refreshed";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function quotaSummary(usage) {
  if (!usage) return "quota pending";
  const plan = usage.planType || "plan unknown";
  const headroom = Math.max(0, Math.min(100, Number(usage.headroom) || 0));
  return `${plan} · ${headroom.toFixed(headroom % 1 ? 1 : 0)}% left`;
}

function emptyState(title, message) {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";
  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.textContent = "···";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = message;
  wrapper.append(icon, heading, text);
  return wrapper;
}

function renderAccounts(accounts) {
  elements.accountList.replaceChildren();
  if (accounts.length === 0) {
    elements.accountList.append(emptyState("No accounts yet", "Import an auth.json to create the pool."));
    return;
  }

  for (const account of accounts) {
    const row = document.createElement("article");
    row.className = "account-row";
    if (!account.enabled) row.classList.add("is-disabled");
    const identity = document.createElement("div");
    identity.className = "account-identity";
    const avatar = document.createElement("span");
    avatar.className = "account-avatar";
    avatar.textContent = (account.label || account.accountId || "A").slice(0, 1).toUpperCase();
    const name = document.createElement("div");
    name.className = "account-name";
    const strong = document.createElement("strong");
    strong.textContent = account.label || "Unnamed account";
    const id = document.createElement("code");
    id.textContent = account.accountId;
    name.append(strong, id);
    identity.append(avatar, name);

    const meta = document.createElement("div");
    meta.className = "account-meta";
    const time = document.createElement("span");
    time.className = "account-time";
    time.textContent = relativeTime(account.updatedAt);
    const state = document.createElement("span");
    const displayState = account.enabled ? account.state : "disabled";
    state.className = accountStateClass(displayState);
    state.textContent = displayState;
    const cap = document.createElement("span");
    cap.className = "account-time";
    cap.textContent = account.concurrencyCap ? `limit ${account.concurrencyCap}` : "unlimited";
    const quota = document.createElement("span");
    quota.className = "account-quota";
    quota.textContent = quotaSummary(account.usage);
    if (account.usage) {
      quota.title = account.usage.windows.map((window) => {
        const reset = window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString()}` : "";
        return `${window.name}: ${window.usedPercent}% used${reset}`;
      }).join("\n");
      time.textContent = `checked ${relativeTime(account.usage.capturedAt)}`;
    }
    meta.append(quota, cap, time, state);

    const check = document.createElement("button");
    check.type = "button";
    check.className = "regenerate-button";
    check.textContent = "Check quota";
    check.disabled = !account.enabled;
    if (!account.enabled) check.title = "Enable the account before checking quota";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "regenerate-button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editingAccountId = account.id;
      elements.accountEditLabel.value = account.label || "";
      elements.accountEditCap.value = String(account.concurrencyCap || 0);
      elements.accountEditMessage.textContent = "";
      elements.accountDialog.showModal();
    });
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = account.enabled ? "revoke-button" : "regenerate-button";
    toggle.textContent = account.enabled ? "Disable" : "Enable";
    const actionMessage = document.createElement("span");
    actionMessage.className = "account-action-message";
    check.addEventListener("click", async () => {
      check.disabled = true;
      edit.disabled = true;
      toggle.disabled = true;
      check.textContent = "Checking…";
      actionMessage.textContent = "";
      try {
        await api(`/admin/api/accounts/${encodeURIComponent(account.id)}/probe`, { method: "POST" });
        await load();
      } catch (error) {
        actionMessage.textContent = error.message;
        check.disabled = false;
        edit.disabled = false;
        toggle.disabled = false;
        check.textContent = "Check quota";
      }
    });
    toggle.addEventListener("click", async () => {
      if (account.enabled && !confirm(`Disable account “${account.label || account.accountId}”? New requests will stop using it.`)) return;
      check.disabled = true;
      edit.disabled = true;
      toggle.disabled = true;
      toggle.textContent = account.enabled ? "Disabling…" : "Enabling…";
      actionMessage.textContent = "";
      try {
        await api(`/admin/api/accounts/${encodeURIComponent(account.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: !account.enabled })
        });
        await load();
      } catch (error) {
        actionMessage.textContent = error.message;
        check.disabled = !account.enabled;
        edit.disabled = false;
        toggle.disabled = false;
        toggle.textContent = account.enabled ? "Disable" : "Enable";
      }
    });
    const buttons = document.createElement("div");
    buttons.className = "account-buttons";
    buttons.append(check, edit, toggle);
    const controls = document.createElement("div");
    controls.className = "account-controls";
    controls.append(meta, buttons, actionMessage);
    row.append(identity, controls);
    elements.accountList.append(row);
  }
}

function strategyLabel(strategy) {
  return {
    fallback: "Fallback",
    "best-quota": "Best quota",
    "load-balance": "Load balance",
    weighted: "Weighted"
  }[strategy] || strategy;
}

function strategySelect(selected) {
  const select = document.createElement("select");
  for (const strategy of ["fallback", "best-quota", "load-balance", "weighted"]) {
    const option = document.createElement("option");
    option.value = strategy;
    option.textContent = strategyLabel(strategy);
    option.selected = strategy === selected;
    select.append(option);
  }
  return select;
}

function updateMemberMoveButtons(container) {
  const choices = [...container.querySelectorAll(".member-choice")];
  for (const [index, choice] of choices.entries()) {
    choice.querySelector('[data-move="up"]').disabled = index === 0;
    choice.querySelector('[data-move="down"]').disabled = index === choices.length - 1;
  }
}

function renderMemberChoices(container, accounts, selected = [], weights = {}) {
  container.replaceChildren();
  if (accounts.length === 0) {
    const note = document.createElement("p");
    note.className = "section-copy";
    note.textContent = "Import an account before configuring policy members.";
    container.append(note);
    return;
  }
  for (const account of orderedMemberAccounts(accounts, selected)) {
    const choice = document.createElement("div");
    choice.className = "member-choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = account.id;
    checkbox.id = `member-choice-${++memberChoiceSequence}`;
    checkbox.checked = selected.includes(account.id);
    const name = document.createElement("label");
    name.htmlFor = checkbox.id;
    name.textContent = `${account.label || account.accountId}${account.enabled ? "" : " (disabled)"}`;
    const weight = document.createElement("input");
    weight.type = "number";
    weight.min = "1";
    weight.max = "1000000";
    weight.step = "1";
    weight.value = String(weights[account.id] || 1);
    weight.title = "Traffic weight";
    weight.setAttribute("aria-label", `Weight for ${name.textContent}`);
    weight.disabled = !checkbox.checked;
    checkbox.addEventListener("change", () => { weight.disabled = !checkbox.checked; });
    const moves = document.createElement("div");
    moves.className = "member-moves";
    for (const [direction, symbol, label] of [["up", "↑", "Move up"], ["down", "↓", "Move down"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.move = direction;
      button.textContent = symbol;
      button.title = label;
      button.setAttribute("aria-label", `${label}: ${name.textContent}`);
      button.addEventListener("click", () => {
        if (direction === "up" && choice.previousElementSibling) {
          container.insertBefore(choice, choice.previousElementSibling);
        } else if (direction === "down" && choice.nextElementSibling) {
          container.insertBefore(choice.nextElementSibling, choice);
        }
        updateMemberMoveButtons(container);
      });
      moves.append(button);
    }
    choice.append(checkbox, name, weight, moves);
    container.append(choice);
  }
  updateMemberMoveButtons(container);
}

function memberConfiguration(container) {
  const memberAccountIds = [];
  const memberWeights = {};
  for (const choice of container.querySelectorAll(".member-choice")) {
    const checkbox = choice.querySelector('input[type="checkbox"]');
    const weightInput = choice.querySelector('input[type="number"]');
    if (!checkbox.checked) continue;
    memberAccountIds.push(checkbox.value);
    memberWeights[checkbox.value] = Number(weightInput.value) || 1;
  }
  return { memberAccountIds, memberWeights };
}

function renderPolicyGroups(policyGroups, accounts) {
  elements.policyGroupList.replaceChildren();
  if (policyGroups.length === 0) {
    elements.policyGroupList.append(emptyState("No policy groups", "Create one to route requests."));
    return;
  }
  const accountLabel = new Map(accounts.map((account) => [account.id, account.label || account.accountId]));
  for (const group of policyGroups) {
    const row = document.createElement("article");
    row.className = "route-row";
    const summary = document.createElement("div");
    summary.className = "route-summary";
    const description = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = group.name;
    const members = document.createElement("span");
    members.textContent = group.memberAccountIds.length
      ? group.memberAccountIds.map((id) => {
          const weight = group.memberWeights[id] || 1;
          return `${accountLabel.get(id) || id}${weight > 1 ? ` ×${weight}` : ""}`;
        }).join(", ")
      : "No members";
    description.append(name, members);
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = strategyLabel(group.strategy);
    summary.append(description, pill);

    const editor = document.createElement("details");
    editor.className = "route-editor";
    const editorSummary = document.createElement("summary");
    editorSummary.textContent = "Configure";
    const body = document.createElement("div");
    body.className = "route-editor-body";
    const groupName = document.createElement("input");
    groupName.value = group.name;
    groupName.maxLength = 80;
    groupName.setAttribute("aria-label", "Policy group name");
    const strategy = strategySelect(group.strategy);
    strategy.setAttribute("aria-label", "Selection strategy");
    const choices = document.createElement("div");
    choices.className = "member-choices";
    renderMemberChoices(choices, accounts, group.memberAccountIds, group.memberWeights);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary-button";
    save.textContent = "Save policy";
    const message = document.createElement("p");
    message.className = "form-message";
    save.addEventListener("click", async () => {
      save.disabled = true;
      message.className = "form-message";
      message.textContent = "Saving…";
      try {
        await api(`/admin/api/policy-groups/${encodeURIComponent(group.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: groupName.value, strategy: strategy.value, ...memberConfiguration(choices) })
        });
        await load();
      } catch (error) {
        message.className = "form-message error";
        message.textContent = error.message;
        save.disabled = false;
      }
    });
    body.append(groupName, strategy, choices, save, message);
    editor.append(editorSummary, body);
    row.append(summary, editor);
    elements.policyGroupList.append(row);
  }
}

function endpointPath(name) {
  return name === "default" ? "/v1/responses" : `/e/${name}/v1/responses`;
}

function endpointBase(name) {
  const base = proxyBase.replace(/\/+$/, "");
  return name === "default" ? `${base}/v1` : `${base}/e/${name}/v1`;
}

function updateClientConfig() {
  const base = endpointBase(elements.configEndpoint.value || "default");
  const key = elements.configKey.value.trim() || "sk-pg-your-key";
  elements.configSnippet.textContent = [
    `export OPENAI_BASE_URL="${base}"`,
    `export OPENAI_API_KEY="${key}"`,
    "",
    `curl -N "${base}/responses" \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model":"gpt-5","input":"hello","stream":true}'`
  ].join("\n");
}

function fillGroupOptions(select, policyGroups, selected = "") {
  select.replaceChildren();
  for (const group of policyGroups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = `${group.name} · ${strategyLabel(group.strategy)}`;
    option.selected = group.id === selected;
    select.append(option);
  }
  select.disabled = policyGroups.length === 0;
}

function renderEndpoints(endpoints, policyGroups) {
  availableEndpoints = endpoints;
  elements.endpointList.replaceChildren();
  fillGroupOptions(elements.endpointGroup, policyGroups, elements.endpointGroup.value);
  elements.endpointCreateButton.disabled = policyGroups.length === 0;

  const previousKeyEndpoint = elements.keyEndpoint.value;
  elements.keyEndpoint.replaceChildren();
  const previousConfigEndpoint = elements.configEndpoint.value;
  elements.configEndpoint.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All endpoints";
  elements.keyEndpoint.append(all);
  for (const endpoint of endpoints) {
    const option = document.createElement("option");
    option.value = endpoint.name;
    option.textContent = endpoint.name;
    option.selected = endpoint.name === previousKeyEndpoint || (!previousKeyEndpoint && endpoint.name === "default");
    elements.keyEndpoint.append(option);

    const configOption = document.createElement("option");
    configOption.value = endpoint.name;
    configOption.textContent = endpoint.name;
    configOption.selected = endpoint.name === previousConfigEndpoint || (!previousConfigEndpoint && endpoint.name === "default");
    elements.configEndpoint.append(configOption);

    const row = document.createElement("article");
    row.className = "route-row route-summary";
    const description = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = endpoint.name;
    const path = document.createElement("span");
    path.className = "route-path";
    path.textContent = endpointPath(endpoint.name);
    description.append(name, path);
    const group = strategySelect(endpoint.strategy);
    fillGroupOptions(group, policyGroups, endpoint.groupId);
    group.setAttribute("aria-label", `Policy group for ${endpoint.name}`);
    group.addEventListener("change", async () => {
      group.disabled = true;
      try {
        await api(`/admin/api/endpoints/${encodeURIComponent(endpoint.name)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ groupId: group.value })
        });
        await load();
      } catch (error) {
        elements.endpointMessage.className = "form-message error";
        elements.endpointMessage.textContent = error.message;
        await load();
      }
    });
    row.append(description, group);
    elements.endpointList.append(row);
  }
  elements.configEndpoint.disabled = endpoints.length === 0;
  updateClientConfig();
}

function scheduleDeviceLoginPoll(seconds) {
  window.clearTimeout(deviceLoginTimer);
  if (!deviceLoginId || !elements.deviceLoginDialog.open) return;
  deviceLoginTimer = window.setTimeout(() => { void pollDeviceLogin(); }, Math.max(1, Number(seconds) || 5) * 1000);
}

async function pollDeviceLogin() {
  if (!deviceLoginId || deviceLoginPolling || !elements.deviceLoginDialog.open) return;
  deviceLoginPolling = true;
  elements.deviceLoginCheck.disabled = true;
  elements.deviceLoginStatus.className = "form-message";
  elements.deviceLoginStatus.textContent = "Checking authorization…";
  try {
    const result = await api(`/admin/api/accounts/login/device/${encodeURIComponent(deviceLoginId)}/poll`, {
      method: "POST"
    });
    if (result.status === "pending") {
      elements.deviceLoginStatus.textContent = "Waiting for authorization…";
      scheduleDeviceLoginPoll(result.retryAfter);
      return;
    }
    elements.deviceLoginMessage.className = "form-message success";
    elements.deviceLoginMessage.textContent = "ChatGPT account connected.";
    elements.deviceLoginDialog.close();
    elements.deviceLoginLabel.value = "";
    await load();
  } catch (error) {
    elements.deviceLoginStatus.className = "form-message error";
    elements.deviceLoginStatus.textContent = error.message;
  } finally {
    deviceLoginPolling = false;
    elements.deviceLoginCheck.disabled = false;
  }
}

async function load() {
  elements.refresh.classList.add("busy");
  try {
    const [status, accountData, keyData, identityData, policyData, endpointData, clientConfig] = await Promise.all([
      api("/admin/api/status"),
      api("/admin/api/accounts"),
      api("/admin/api/api-keys"),
      api("/admin/api/identity"),
      api("/admin/api/policy-groups"),
      api("/admin/api/endpoints"),
      api("/admin/api/client-config")
    ]);
    elements.accountCount.textContent = String(status.accounts);
    elements.endpointCount.textContent = String(status.endpoints);
    elements.apiKeyCount.textContent = String(status.apiKeys);
    elements.schemaVersion.textContent = `v${status.schemaVersion}`;
    elements.accessIdentity.textContent = identityData.identity.email || "Cloudflare Access";
    proxyBase = clientConfig.proxyBase;
    availableEndpoints = endpointData.endpoints;
    renderAccounts(accountData.accounts);
    renderApiKeys(keyData.apiKeys);
    renderMemberChoices(elements.policyMembers, accountData.accounts);
    renderPolicyGroups(policyData.policyGroups, accountData.accounts);
    renderEndpoints(endpointData.endpoints, policyData.policyGroups);
    elements.serviceState.dataset.state = "ok";
    elements.serviceStateText.textContent = "Coordinator online";
    elements.updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    elements.serviceState.dataset.state = "error";
    elements.serviceStateText.textContent = "Unavailable";
    elements.accountList.replaceChildren(emptyState("Could not load the pool", error.message));
    elements.apiKeyList.replaceChildren(emptyState("Could not load API keys", error.message));
  } finally {
    elements.refresh.classList.remove("busy");
  }
}

elements.refresh.addEventListener("click", load);
elements.deviceLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.deviceLoginButton.disabled = true;
  elements.deviceLoginMessage.className = "form-message";
  elements.deviceLoginMessage.textContent = "Starting secure device sign-in…";
  try {
    const result = await api("/admin/api/accounts/login/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: elements.deviceLoginLabel.value })
    });
    deviceLoginId = result.loginId;
    elements.deviceLoginCode.textContent = result.userCode;
    elements.deviceLoginOpen.href = result.verificationUrl;
    elements.deviceLoginStatus.className = "form-message";
    elements.deviceLoginStatus.textContent = `Waiting for authorization · expires ${new Date(result.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    elements.deviceLoginMessage.textContent = "Complete authorization in the sign-in dialog.";
    elements.deviceLoginDialog.showModal();
    scheduleDeviceLoginPoll(result.intervalSeconds);
  } catch (error) {
    elements.deviceLoginMessage.className = "form-message error";
    elements.deviceLoginMessage.textContent = error.message;
  } finally {
    elements.deviceLoginButton.disabled = false;
  }
});

elements.deviceLoginCheck.addEventListener("click", () => { void pollDeviceLogin(); });
elements.deviceLoginCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.deviceLoginCode.textContent);
    elements.deviceLoginCopy.textContent = "Copied";
  } catch {
    elements.deviceLoginCopy.textContent = "Select code above";
  }
});
elements.deviceLoginDialogClose.addEventListener("click", () => elements.deviceLoginDialog.close());
elements.deviceLoginDialog.addEventListener("click", (event) => {
  if (event.target === elements.deviceLoginDialog) elements.deviceLoginDialog.close();
});
elements.deviceLoginDialog.addEventListener("close", () => {
  window.clearTimeout(deviceLoginTimer);
  deviceLoginTimer = 0;
  deviceLoginId = "";
  elements.deviceLoginCode.textContent = "";
  elements.deviceLoginOpen.removeAttribute("href");
  elements.deviceLoginCopy.textContent = "Copy code";
  elements.deviceLoginStatus.className = "form-message";
  elements.deviceLoginStatus.textContent = "Waiting for authorization…";
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.importButton.disabled = true;
  elements.formMessage.className = "form-message";
  elements.formMessage.textContent = "Encrypting and importing credentials…";
  try {
    await api("/admin/api/accounts/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: elements.label.value, content: elements.content.value })
    });
    elements.content.value = "";
    elements.formMessage.className = "form-message success";
    elements.formMessage.textContent = "Account imported.";
    await load();
  } catch (error) {
    elements.formMessage.className = "form-message error";
    elements.formMessage.textContent = error.message;
  } finally {
    elements.importButton.disabled = false;
  }
});

elements.keyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.createKeyButton.disabled = true;
  elements.keyFormMessage.className = "form-message";
  elements.keyFormMessage.textContent = "Creating an explicitly authorized key…";
  try {
    const expiry = elements.keyExpiry.value;
    const result = await api("/admin/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: elements.keyLabel.value,
        endpoints: elements.keyEndpoint.value ? [elements.keyEndpoint.value] : [],
        ipAllowlist: ipAllowlistInput(elements.keyIpAllowlist.value),
        expiresInDays: expiry ? Number(expiry) : undefined
      })
    });
    elements.keyLabel.value = "";
    elements.keyIpAllowlist.value = "";
    elements.keyFormMessage.className = "form-message success";
    elements.keyFormMessage.textContent = "Proxy key created.";
    showNewKey(result.apiKey);
    await load();
  } catch (error) {
    elements.keyFormMessage.className = "form-message error";
    elements.keyFormMessage.textContent = error.message;
  } finally {
    elements.createKeyButton.disabled = false;
  }
});

elements.copyKey.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.keyValue.textContent);
    elements.copyKey.textContent = "Copied";
  } catch {
    elements.copyKey.textContent = "Select and copy the key above";
  }
});
elements.dialogClose.addEventListener("click", () => elements.keyDialog.close());
elements.keyDialog.addEventListener("click", (event) => {
  if (event.target === elements.keyDialog) elements.keyDialog.close();
});
elements.keyDialog.addEventListener("close", () => {
  elements.keyValue.textContent = "";
  elements.copyKey.textContent = "Copy API key";
});

elements.keyEditDialogClose.addEventListener("click", () => elements.keyEditDialog.close());
elements.keyEditDialog.addEventListener("click", (event) => {
  if (event.target === elements.keyEditDialog) elements.keyEditDialog.close();
});
elements.keyEditDialog.addEventListener("close", () => {
  editingApiKeyId = "";
  elements.keyEditForm.reset();
  elements.keyEditMessage.textContent = "";
});
elements.keyEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingApiKeyId) return;
  elements.keyEditSaveButton.disabled = true;
  elements.keyEditMessage.className = "form-message";
  elements.keyEditMessage.textContent = "Saving non-secret metadata…";
  const body = {
    label: elements.keyEditLabel.value,
    ipAllowlist: ipAllowlistInput(elements.keyEditIpAllowlist.value)
  };
  if (elements.keyEditEndpoint.value !== "__keep__") {
    body.endpoints = elements.keyEditEndpoint.value ? [elements.keyEditEndpoint.value] : [];
  }
  if (elements.keyEditExpiry.value !== "__keep__") {
    body.expiresInDays = elements.keyEditExpiry.value ? Number(elements.keyEditExpiry.value) : null;
  }
  try {
    await api(`/admin/api/api-keys/${encodeURIComponent(editingApiKeyId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    elements.keyEditDialog.close();
    await load();
  } catch (error) {
    elements.keyEditMessage.className = "form-message error";
    elements.keyEditMessage.textContent = error.message;
  } finally {
    elements.keyEditSaveButton.disabled = false;
  }
});

elements.accountDialogClose.addEventListener("click", () => elements.accountDialog.close());
elements.accountDialog.addEventListener("click", (event) => {
  if (event.target === elements.accountDialog) elements.accountDialog.close();
});
elements.accountDialog.addEventListener("close", () => {
  editingAccountId = "";
  elements.accountEditForm.reset();
  elements.accountEditMessage.textContent = "";
});
elements.accountEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingAccountId) return;
  elements.accountSaveButton.disabled = true;
  elements.accountEditMessage.className = "form-message";
  elements.accountEditMessage.textContent = "Saving…";
  try {
    await api(`/admin/api/accounts/${encodeURIComponent(editingAccountId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: elements.accountEditLabel.value,
        concurrencyCap: Number(elements.accountEditCap.value)
      })
    });
    elements.accountDialog.close();
    await load();
  } catch (error) {
    elements.accountEditMessage.className = "form-message error";
    elements.accountEditMessage.textContent = error.message;
  } finally {
    elements.accountSaveButton.disabled = false;
  }
});

elements.policyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.policyCreateButton.disabled = true;
  elements.policyMessage.className = "form-message";
  elements.policyMessage.textContent = "Creating…";
  try {
    await api("/admin/api/policy-groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: elements.policyName.value,
        strategy: elements.policyStrategy.value,
        ...memberConfiguration(elements.policyMembers)
      })
    });
    elements.policyForm.reset();
    elements.policyMessage.className = "form-message success";
    elements.policyMessage.textContent = "Policy group created.";
    await load();
  } catch (error) {
    elements.policyMessage.className = "form-message error";
    elements.policyMessage.textContent = error.message;
  } finally {
    elements.policyCreateButton.disabled = false;
  }
});

elements.endpointForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.endpointCreateButton.disabled = true;
  elements.endpointMessage.className = "form-message";
  elements.endpointMessage.textContent = "Creating…";
  try {
    await api("/admin/api/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: elements.endpointName.value, groupId: elements.endpointGroup.value })
    });
    elements.endpointName.value = "";
    elements.endpointMessage.className = "form-message success";
    elements.endpointMessage.textContent = "Endpoint created.";
    await load();
  } catch (error) {
    elements.endpointMessage.className = "form-message error";
    elements.endpointMessage.textContent = error.message;
  } finally {
    elements.endpointCreateButton.disabled = false;
  }
});

elements.configEndpoint.addEventListener("change", updateClientConfig);
elements.configKey.addEventListener("input", updateClientConfig);
elements.copyConfig.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.configSnippet.textContent);
    elements.configMessage.className = "form-message success";
    elements.configMessage.textContent = "Configuration copied.";
  } catch {
    elements.configMessage.className = "form-message error";
    elements.configMessage.textContent = "Copy failed. Select the snippet manually.";
  }
});
elements.clearConfig.addEventListener("click", () => {
  elements.configKey.value = "";
  elements.configMessage.textContent = "Key cleared from this page.";
  updateClientConfig();
});
window.addEventListener("pagehide", () => { elements.configKey.value = ""; });

void load();
