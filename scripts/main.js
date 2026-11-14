import { ATTRIBUTES, ARCHETYPES, SCENES, ACTIONS, resolveTest } from "./rules.mjs";

const ID = "brutal-rpg";
const { api, apps, sheets } = foundry.applications;
const { DialogV2 } = api;
const warn = message => ui.notifications.warn(message);
const escapeHTML = value => String(value).replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const sceneType = () => game.settings.get(ID, "sceneType");
const directorState = () => game.settings.get(ID, "directorState");
const publicState = () => game.settings.get(ID, "publicState");
const activeDirector = () => game.users.activeGM?.id === game.user.id;
const actorType = (actor, type) => actor?.type === type;
let directorQueue = Promise.resolve();
const actorQueues = new WeakMap();

function queueActor(actor, operation) {
  const pending = (actorQueues.get(actor) ?? Promise.resolve()).catch(() => {}).then(operation);
  actorQueues.set(actor, pending);
  return pending;
}

class SurvivorData extends foundry.abstract.TypeDataModel {
  static migrateData(source) {
    if (source.stereotype === "heroi") source.stereotype = "corajoso";
    if (source.attributes && !source.attributes.inteligencia) {
      source.attributes.inteligencia = source.attributes.astucia ?? source.attributes.mental;
    }
    if (["astucia", "astúcia", "mental", "intelecto"].includes(source.bonusAttribute?.toLocaleLowerCase("pt-BR"))) {
      source.bonusAttribute = "inteligencia";
    }
    return super.migrateData(source);
  }

  static defineSchema() {
    const { BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;
    const count = (initial = 0, max) => new NumberField({ integer: true, min: 0, max, initial, nullable: false });
    const text = () => new StringField({ blank: true, initial: "" });
    return {
      attributes: new SchemaField(Object.fromEntries(Object.keys(ATTRIBUTES).map(key => [
        key, new SchemaField({ trained: new BooleanField() })
      ]))),
      pool: count(6, 6),
      tension: count(0, 10),
      wounds: count(0, 6),
      sequelae: count(0, 5),
      escapeDice: count(),
      escaped: new BooleanField(),
      dead: new BooleanField(),
      stereotype: text(),
      bonusAttribute: text(),
      ability: text(),
      scars: text(),
      background: text(),
      equipment: text(),
      iconicItem: text(),
      relationship: text(),
      desire: text()
    };
  }
}

class KillerData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const { NumberField, StringField } = foundry.data.fields;
    const count = (initial = 0, min = 0, max) =>
      new NumberField({ integer: true, min, max, initial, nullable: false });
    const text = () => new StringField({ blank: true, initial: "" });
    return {
      pool: count(),
      horror: count(),
      primary: text(),
      secondary: text(),
      primaryLevel: count(2, 2, 6),
      secondaryLevel: count(2, 2, 6),
      passive: text(),
      special: text(),
      uniqueActions: text()
    };
  }
}

function select(name, choices, selected = "") {
  return `<select name="${name}">${Object.entries(choices).map(([value, label]) =>
    `<option value="${escapeHTML(value)}" ${selected === value ? "selected" : ""}>${escapeHTML(label)}</option>`
  ).join("")}</select>`;
}

function dialog(title, content, label = "Confirmar") {
  return DialogV2.wait({
    window: { title }, content, rejectClose: false,
    buttons: [
      { action: "confirm", label, default: true,
        callback: (_event, button) => Object.fromEntries(new FormData(button.form)) },
      { action: "cancel", label: "Cancelar" }
    ]
  });
}

async function postEffect(actor, title, effect, roll, detail = "") {
  const message = {
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `<strong>${escapeHTML(title)}</strong>${detail}`,
    flags: effect ? { [ID]: { effect: { ...effect, actor: actor.uuid } } } : {}
  };
  if (roll) return roll.toMessage(message);
  return ChatMessage.create({ ...message, content: escapeHTML(title) });
}

function eligible(actor) {
  return actor?.isOwner && actorType(actor, "personagem") && !actor.system.dead &&
    (sceneType() !== "encontro" || !actor.system.escaped);
}

async function offerDice(actor) {
  if (!eligible(actor) || !actor.system.pool) return warn("Escolha uma Sobrevivente com dados.");
  const state = publicState();
  if (!state.riteOpen) return warn("A Diretora precisa abrir o Rito de Iniciação.");
  const form = await dialog("Oferenda", `
    <label>Dados <input name="dice" type="number" min="1" max="${actor.system.pool}" value="1"></label>
    <label>Objetivo ${select("purpose", { favorable: "Clamores favoráveis", neutral: "Neutralizar clamores desfavoráveis" })}</label>
  `, "Ofertar");
  const dice = Number(form?.dice);
  if (!Number.isInteger(dice) || dice < 1) return;
  return queueActor(actor, async () => {
    const current = publicState();
    if (!current.riteOpen || current.riteId !== state.riteId || actor.system.pool < dice) return warn("O Rito ou a pilha mudou.");
    const roll = await new Roll(`${dice}d6`).evaluate();
    const successes = roll.dice[0].results.filter(die => die.result > 3).length;
    await actor.update({ "system.pool": actor.system.pool - dice });
    return postEffect(actor, "Oferenda do Rito", { losses: dice, destination: "discard",
      riteId: state.riteId, purpose: form.purpose, successes }, roll, `<p>${successes} oferendas aceitas</p>`);
  });
}

async function rollTest(actor, action = "risk", attribute = "") {
  const config = ACTIONS[action];
  if (!eligible(actor) || !config) return warn("Escolha uma Sobrevivente ativa sob seu controle.");
  const scene = sceneType();
  if (!["risk", "fright"].includes(action) && scene !== "encontro") return warn("Esta ação exige um Encontro.");
  const max = actor.system.pool;
  if (!max) return warn("A pilha comum está vazia.");
  const fright = action === "fright";
  const content = `
    ${fright ? "" : `<label>Atributo ${select("attribute", ATTRIBUTES, attribute || config.attribute)}</label>
    <label>Dados a arriscar <input name="dice" type="number" min="1" max="${max}" value="1" required></label>
    <label>Sucessos necessários <input name="required" type="number" min="1" max="6" value="${config.required ?? 1}" required></label>
    <label>Recurso autorizado ${select("resource", { "": "Nenhum", difficulty: "Reduzir dificuldade em 1", complexity: "Reduzir sucessos exigidos em 1" })}</label>`}
  `;
  const form = await dialog(config.label, content, "Rolar");
  if (form?.constructor !== Object) return;
  const dice = fright ? 1 : Number(form.dice);
  const required = fright ? 1 : Number(form.required);
  if (!Number.isInteger(dice) || dice < 1 || !Number.isInteger(required) || required < 1 || required > 6) return;
  return queueActor(actor, async () => {
    const system = actor.system;
    if (!eligible(actor) || scene !== sceneType() || dice > system.pool) return warn("A cena ou a pilha mudou. Abra o teste novamente.");
    const roll = await new Roll(`${dice}d6`).evaluate();
    const result = resolveTest({
      faces: roll.dice[0].results.map(die => die.result),
      required, specialty: !fright && Boolean(system.attributes[form.attribute]?.trained),
      resource: form.resource, action, scene, pool: system.pool
    });
    const effect = { losses: action === "help" ? 0 : result.failures, destination: result.destination,
      encounterId: publicState().encounterId ?? "" };
    const update = { "system.pool": action === "help" ? system.pool : result.remaining };
    if (action === "escape") {
      update["system.escapeDice"] = system.escapeDice + result.escapeDice;
      if (result.escapeDice) effect.checkEscape = true;
    }
    if (result.success && action === "fight") effect.fight = true;
    if (result.success && action === "distract") effect.distract = true;
    if (result.success && action === "help") effect.donate = result.successes;
    if (fright && result.failures) effect.fright = true;
    const pending = effect.losses || effect.checkEscape || effect.fight || effect.distract || effect.donate;
    const outcome = result.disaster ? "Desastre" : result.success ? "Sucesso" : "Falha";
    const detail = `<p>${outcome} · ${result.successes}/${result.needed} sucessos · dificuldade ${result.target}${result.escapeDice ? ` · +${result.escapeDice} dados de fuga` : ""}</p>`;
    await actor.update(update);
    await postEffect(actor, config.label, pending ? effect : null, roll, detail);
  });
}

async function requestAction(actor, action) {
  if (!eligible(actor)) return warn("Escolha uma Sobrevivente ativa sob seu controle.");
  const titles = {
    breathe: "Recuperar o Fôlego", allIn: "Arriscar Tudo", reality: "Choque de Realidade",
    heal: "Cuidar de Feridas", iconic: "Item icônico", relationship: "Relação afetiva",
    desire: "Desejo obscuro"
  };
  const encounter = sceneType() === "encontro";
  if ((["breathe", "allIn"].includes(action) && !encounter) ||
      (["reality", "heal"].includes(action) && encounter)) return warn("Ação indisponível nesta cena.");
  if (!Object.hasOwn(titles, action)) return;
  let amount = 0;
  if (action === "heal") {
    const form = await dialog(titles[action], '<label>PT a gastar <input name="amount" type="number" min="1" max="6" value="1"></label>');
    amount = Number(form?.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > 6) return;
  }
  return postEffect(actor, titles[action], { action, amount, encounterId: publicState().encounterId ?? "" });
}

function survivorChoices(exclude) {
  return Object.fromEntries(game.actors.filter(actor =>
    actorType(actor, "personagem") && !actor.system.dead && actor !== exclude &&
    (sceneType() !== "encontro" || !actor.system.escaped)
  ).map(actor => [actor.id, actor.name]));
}

async function updateFromCard(message) {
  if (!activeDirector()) return warn("A Diretora ativa deve aplicar este cartão.");
  if (message.getFlag(ID, "applied")) return;
  const storedEffect = message.getFlag(ID, "effect");
  if (!storedEffect) return;
  const effect = foundry.utils.deepClone(storedEffect);
  const actor = await fromUuid(effect.actor);
  if (!actorType(actor, "personagem")) return warn("Sobrevivente indisponível.");
  if (!message.author || !actor.testUserPermission(message.author, "OWNER")) return warn("O autor não controla a Sobrevivente.");
  if (effect.losses !== undefined && (!Number.isInteger(effect.losses) || effect.losses < 0 || effect.losses > 6)) {
    return warn("Quantidade inválida no cartão.");
  }
  const state = foundry.utils.deepClone(directorState());
  const encounterEffect = effect.checkEscape || effect.fight || effect.distract || effect.donate ||
    ["breathe", "allIn"].includes(effect.action);
  if (encounterEffect && (sceneType() !== "encontro" || effect.encounterId !== state.encounterId)) {
    if (!effect.losses) return warn("Este cartão pertence a um Encontro encerrado.");
    for (const key of ["checkEscape", "fight", "distract", "donate", "action"]) delete effect[key];
  }
  if (["reality", "heal"].includes(effect.action) && sceneType() === "encontro") return warn("A vantagem só pode ser aplicada fora do Encontro.");
  const killer = game.actors.get(state.killerId);
  const source = actor.system;
  const actorUpdate = {};
  const killerUpdate = {};
  let target;
  let targetUpdate;
  let discard = state.discard;
  if (effect.riteId && effect.riteId === state.riteId) {
    if (effect.purpose === "neutral") {
      const converted = Math.min(effect.successes, state.unfavorable);
      state.unfavorable -= converted;
      state.neutral += converted;
    } else state.favorable += effect.successes;
  }
  if (effect.fright && killer) {
    const choice = await DialogV2.confirm({
      window: { title: "Intento Horrível" },
      content: "<p>Creditar 1 PH pela primeira falha deste susto?</p>",
      rejectClose: false
    });
    if (choice) killerUpdate["system.horror"] = killer.system.horror + 1;
  }
  if (effect.losses) {
    if (effect.destination === "sacrifice") {
      if (!killer) return warn("Selecione o Assassino no painel.");
      killerUpdate["system.pool"] = killer.system.pool + effect.losses;
    } else discard += effect.losses;
  }
  if (effect.fight) {
    if (!killer) return warn("Selecione o Assassino no painel.");
    const loss = Math.min(1, killer.system.pool);
    discard += loss;
    killerUpdate["system.pool"] = killer.system.pool - loss;
  }
  if (effect.distract) state.killSurcharge += 1;
  if (effect.checkEscape && source.escapeDice >= state.escapeSteps) actorUpdate["system.escaped"] = true;
  if (effect.donate || effect.action === "heal") {
    const choices = survivorChoices(effect.donate ? actor : null);
    if (!Object.keys(choices).length) return warn("Sem alvo elegível.");
    const form = await dialog("Escolher Sobrevivente", select("target", choices, actor.id));
    if (!form?.target) return;
    target = game.actors.get(form.target);
    if (!target || target.system.dead || (sceneType() === "encontro" && target.system.escaped)) return warn("Alvo indisponível.");
    if (effect.donate) {
      const amount = Math.min(effect.donate, actor.system.pool, 6 - target.system.pool);
      if (!amount) return warn("O doador ou o alvo não pode transferir dados agora.");
      actorUpdate["system.pool"] = actor.system.pool - amount;
      targetUpdate = { "system.pool": target.system.pool + amount };
    } else {
      const amount = Math.min(effect.amount, target.system.wounds - target.system.sequelae);
      if (state.healed?.includes(actor.uuid) || amount < 1 || actor.system.tension < amount) return warn("Cura indisponível.");
      actorUpdate["system.tension"] = actor.system.tension - amount;
      targetUpdate = { "system.wounds": target.system.wounds - amount };
      state.healed = [...(state.healed ?? []), actor.uuid];
    }
  }
  if (effect.action === "breathe" || effect.action === "reality") {
    const cost = effect.action === "reality" ? 6 : 0;
    if (cost && !killer) return warn("Selecione o Assassino no painel.");
    if (!discard || source.pool >= 6 || source.tension < cost) return warn("Sem dados no descarte, espaço na pilha ou PT suficientes.");
    actorUpdate["system.pool"] = source.pool + 1;
    actorUpdate["system.tension"] = source.tension - cost;
    discard -= 1;
    if (cost) killerUpdate["system.horror"] = killer.system.horror + 1;
  }
  if (effect.action === "allIn") {
    if (state.allInUsed || state.allInEncounter || Object.keys(survivorChoices(actor)).length === 0) return warn("Arriscar Tudo indisponível.");
    state.allInUsed = true;
    state.allInEncounter = true;
    discard += source.pool;
    Object.assign(actorUpdate, { "system.pool": 0, "system.escaped": true });
  }
  const reward = { iconic: 1, relationship: 2, desire: 3 }[effect.action];
  if (reward) actorUpdate["system.tension"] = Math.min(10, source.tension + reward);
  state.discard = discard;
  if (target === actor) Object.assign(actorUpdate, targetUpdate);
  else if (targetUpdate) await target.update(targetUpdate);
  if (Object.keys(actorUpdate).length) await actor.update(actorUpdate);
  if (Object.keys(killerUpdate).length) await killer.update(killerUpdate);
  await game.settings.set(ID, "directorState", state);
  await message.setFlag(ID, "applied", true);
}

function directorOperation(operation) {
  const result = directorQueue.catch(() => {}).then(operation);
  directorQueue = result;
  result.catch(error => {
    console.error("Brutal RPG", error);
    ui.notifications.error("Não foi possível concluir a operação. Confira os valores no painel.");
  });
  return result;
}

async function openPanel() {
  if (!activeDirector()) return warn("Painel reservado à Diretora ativa.");
  const state = directorState();
  const killers = Object.fromEntries(game.actors.filter(actor => actorType(actor, "assassino"))
    .map(actor => [actor.id, actor.name]));
  const killer = game.actors.get(state.killerId);
  const rank = actor => ARCHETYPES[actor.system.stereotype]?.rank ?? 9;
  const order = game.actors.filter(actor => actorType(actor, "personagem") && !actor.system.dead && !actor.system.escaped)
    .sort((a, b) => rank(a) - rank(b))
    .map(actor => escapeHTML(actor.name));
  const form = await dialog("Painel da Diretora", `
    <label>Cena ${select("scene", SCENES, sceneType())}</label>
    <label>Assassino ${select("killer", { "": "Selecione", ...killers }, state.killerId)}</label>
    <label>Dados no descarte <input name="discard" type="number" min="0" value="${state.discard}"></label>
    <label>Etapas de fuga <input name="steps" type="number" min="1" value="${state.escapeSteps}"></label>
    <label>Ação ${select("action", { save: "Salvar", encounter: "Iniciar Encontro", session: "Abrir Rito / iniciar sessão",
      offering: "Oferenda da Diretora", endRite: "Encerrar Rito", favorable: "Clamar favorável",
      neutral: "Clamar neutra", unfavorable: "Clamar desfavorável", progress: "Concluir Passo de Suspense",
      ferir: "Ferir", matar: "Matar", dificultar: "Dificultar", escapar: "Encerrar Encontro: Assassino escapa" })}</label>
    <label>Alvo ${select("target", { "": "Selecione", ...survivorChoices() })}</label>
    <p>${killer ? `Pilha: ${killer.system.pool} · PH: ${killer.system.horror}` : ""}</p>
    <p>Custo extra de Matar: ${state.killSurcharge}</p>
    <p>Iniciativa: ${[...order, "Assassino"].join(" → ")}</p>
    <p>Clamores: ${state.favorable ?? 0} favoráveis · ${state.neutral ?? 0} neutros · ${state.unfavorable ?? 0} desfavoráveis</p>
    <label>Passos de Suspense <input name="goal" type="number" min="1" value="${state.goal ?? 1}"></label>
    <p>Passos concluídos: ${state.progress ?? 0}</p>
  `, "Executar");
  if (!form?.action) return;
  return directorOperation(async () => {
    const current = foundry.utils.deepClone(directorState());
    if (JSON.stringify(current) !== JSON.stringify(state)) return warn("O estado mudou. Abra o painel novamente.");
    const selected = game.actors.get(form.killer);
    if (form.killer && !actorType(selected, "assassino")) return warn("Escolha um Assassino.");
    const discard = Number(form.discard);
    const steps = Number(form.steps);
    const goal = Number(form.goal);
    if (!Number.isInteger(discard) || discard < 0 || !Number.isInteger(steps) || steps < 1 ||
        !Number.isInteger(goal) || goal < 1) return;
    current.killerId = form.killer;
    current.discard = discard;
    current.escapeSteps = steps;
    current.goal = goal;
    let scene = sceneType();
    if (form.action === "save") {
      if (form.scene === "encontro" && scene !== "encontro") return warn("Use Iniciar Encontro para preparar a cena.");
      if (form.scene === "suspense" && scene !== "suspense") current.progress = 0;
      scene = form.scene;
    } else if (form.action === "session") {
      if (!selected?.system.pool || current.riteOpen) return warn("Selecione um Assassino com dados e encerre o Rito anterior.");
      const roll = await new Roll("1d6").evaluate();
      await postEffect(selected, "Rito de Iniciação", null, roll);
      current.allInUsed = false;
      current.riteOpen = true;
      current.riteId = foundry.utils.randomID();
      current.favorable = 0;
      current.neutral = 0;
      current.unfavorable = roll.total;
      current.offerings = 0;
    } else if (form.action === "offering") {
      if (!current.riteOpen || !selected?.system.pool ||
          current.offerings >= Math.min(selected.system.primaryLevel, selected.system.secondaryLevel)) return warn("Oferenda indisponível.");
      const roll = await new Roll("1d6").evaluate();
      await selected.update({ "system.pool": selected.system.pool - 1 });
      await postEffect(selected, "Oferenda da Diretora", null, roll);
      current.offerings++;
      current.discard++;
      current.unfavorable += roll.total;
    } else if (form.action === "endRite") {
      current.riteOpen = false;
    } else if (["favorable", "neutral", "unfavorable"].includes(form.action)) {
      if (!current[form.action]) return warn("Sem clamores deste tipo.");
      current[form.action]--;
    } else if (form.action === "progress") {
      if (scene !== "suspense") return warn("A ação exige uma Cena de Suspense.");
      current.progress = Math.min(goal, (current.progress ?? 0) + 1);
      if (current.progress >= goal) scene = "livre";
    } else if (form.action === "encounter") {
      if (!selected || scene === "encontro") return warn("Selecione um Assassino e encerre o Encontro atual.");
      const survivors = game.actors.filter(actor => actorType(actor, "personagem") && !actor.system.dead);
      if (survivors.some(actor => actor.system.pool >= selected.system.pool)) return warn("O Assassino precisa ter mais dados que cada Sobrevivente.");
      current.escapeSteps = Math.max(selected.system.primaryLevel, selected.system.secondaryLevel) + 1;
      current.killSurcharge = 0;
      current.allInEncounter = false;
      current.encounterId = foundry.utils.randomID();
      current.healed = [];
      scene = "encontro";
      for (const actor of survivors) await actor.update({ "system.escapeDice": 0, "system.escaped": false });
    } else {
      if (scene !== "encontro" || !selected) return warn("A ação exige um Encontro com Assassino.");
      if (form.action === "dificultar") {
        if (selected.system.horror < 4) return warn("São necessários 4 PH.");
        await selected.update({ "system.horror": selected.system.horror - 4 });
        current.escapeSteps++;
      }
      if (form.action === "escapar") {
        await selected.update({ "system.pool": selected.system.pool + 1 });
        scene = "livre";
      }
      if (form.action === "ferir" || form.action === "matar") {
        const target = game.actors.get(form.target);
        if (!actorType(target, "personagem") || target.system.dead || target.system.escaped) return warn("Escolha um alvo ativo.");
        if (form.action === "matar") {
          const cost = 2 + current.killSurcharge;
          if (selected.system.pool <= target.system.pool || selected.system.pool < cost) return warn("Pilha insuficiente para Matar.");
          await target.update({ "system.dead": true });
          await selected.update({ "system.pool": selected.system.pool - cost, "system.horror": selected.system.horror + 1 });
          current.discard += cost;
          current.killSurcharge = 0;
        } else {
          if (!selected.system.pool) return warn("O Assassino está sem dados.");
          const roll = await new Roll("1d6").evaluate();
          const face = roll.total;
          if (face === 6) {
            await postEffect(selected, "Ferir · decisão da Diretora", null, roll);
            const decision = await dialog("Ferir: resultado 6", select("choice", { kill: "Matar", maim: "Mutilar" }));
            if (!decision?.choice) return;
            const maim = decision.choice === "maim";
            const sequelae = Math.min(5, target.system.sequelae + 3);
            await target.update(maim
              ? { "system.sequelae": sequelae, "system.wounds": Math.max(sequelae, target.system.wounds) }
              : { "system.dead": true });
            await selected.update({ "system.pool": selected.system.pool - 1,
              "system.horror": selected.system.horror + (maim ? 4 : 1) });
            current.discard++;
          } else {
            const wounds = Math.min(6, target.system.wounds + face);
            await target.update({ "system.wounds": wounds, "system.sequelae": Math.min(5, target.system.sequelae + 1),
              "system.dead": wounds >= 6 });
            await selected.update({ "system.pool": selected.system.pool - 1,
              "system.horror": selected.system.horror + Number(wounds >= 6) });
            await postEffect(selected, "Ferir", null, roll);
          }
        }
      }
    }
    await game.settings.set(ID, "directorState", current);
    await game.settings.set(ID, "publicState", { encounterId: current.encounterId ?? "",
      riteOpen: current.riteOpen ?? false, riteId: current.riteId ?? "" });
    if (scene !== sceneType()) await game.settings.set(ID, "sceneType", scene);
  });
}

function selectedActor() {
  return canvas.tokens?.controlled[0]?.actor ?? game.user.character;
}

class BrutalSheet extends api.HandlebarsApplicationMixin(sheets.ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    tag: "form", classes: ["brutal-sheet"], position: { width: 680, height: 740 },
    window: { resizable: true }, form: { submitOnChange: true, closeOnSubmit: false },
    actions: {
      test(_event, button) { return rollTest(this.actor, button.dataset.test, button.dataset.attribute); },
      request(_event, button) { return requestAction(this.actor, button.dataset.request); },
      offer() { return offerDice(this.actor); },
      initialize() {
        if (!activeDirector() || !actorType(this.actor, "assassino")) return;
        const { primaryLevel, secondaryLevel } = this.actor.system;
        return this.actor.update({ "system.pool": primaryLevel + secondaryLevel, "system.horror": primaryLevel });
      }
    }
  };

  static PARTS = { main: { template: `systems/${ID}/templates/sheet.hbs`, scrollable: [""] } };

  async _onChangeForm(formConfig, event) {
    const input = event.target;
    if (input?.name !== "system.stereotype") return super._onChangeForm(formConfig, event);
    if (!this.isEditable || !Object.hasOwn(ARCHETYPES, input.value)) return;
    const { specialties } = ARCHETYPES[input.value];
    const changes = { "system.stereotype": input.value };
    for (const key of Object.keys(ATTRIBUTES)) {
      changes[`system.attributes.${key}.trained`] = specialties.includes(key);
    }
    const saved = this.actor.system.bonusAttribute?.trim().toLocaleLowerCase("pt-BR");
    if (specialties.some(key => saved === key || saved === ATTRIBUTES[key].toLocaleLowerCase("pt-BR"))) {
      changes["system.bonusAttribute"] = "";
    }
    await this.actor.update(changes);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const system = actor.system;
    const attributes = Object.entries(ATTRIBUTES).map(([key, label]) => ({
      key, label, trained: system.attributes?.[key]?.trained ?? false
    }));
    const saved = system.bonusAttribute?.trim().toLocaleLowerCase("pt-BR");
    const bonusAttributes = attributes.filter(attribute => !attribute.trained).map(attribute => ({
      ...attribute, selected: [attribute.key, attribute.label.toLocaleLowerCase("pt-BR")].includes(saved)
    }));
    const archetypes = Object.entries(ARCHETYPES).map(([key, data]) => ({
      key, label: data.label, selected: key === system.stereotype
    }));
    return { ...context, actor, system, attributes, bonusAttributes, archetypes,
      missingSpecialties: Boolean(ARCHETYPES[system.stereotype]) && attributes.filter(attribute => attribute.trained).length < 2,
      gm: game.user.isGM, killer: actorType(actor, "assassino"),
      scene: SCENES[sceneType()], encounter: sceneType() === "encontro" };
  }
}

Hooks.once("init", () => {
  game.settings.register(ID, "sceneType", {
    scope: "world", config: false, type: String, default: "livre",
    onChange: () => { for (const actor of game.actors ?? []) if (actor._sheet?.rendered) actor._sheet.render(); }
  });
  game.settings.register(ID, "publicState", {
    scope: "world", config: false, type: Object, default: { encounterId: "", riteOpen: false, riteId: "" }
  });
  game.settings.register(ID, "directorState", {
    scope: "world", config: false, type: Object, restricted: true,
    default: { killerId: "", discard: 0, escapeSteps: 3, killSurcharge: 0, allInUsed: false, healed: [] }
  });
  game.settings.registerMenu(ID, "directorPanel", {
    name: "Painel da Diretora", label: "Abrir painel", icon: "fas fa-mask",
    type: class extends api.ApplicationV2 { render() { return openPanel(); } }, restricted: true
  });
  Object.assign(CONFIG.Actor.dataModels, { personagem: SurvivorData, assassino: KillerData });
  apps.DocumentSheetConfig.registerSheet(foundry.documents.Actor, ID, BrutalSheet, {
    types: ["personagem", "assassino"], makeDefault: true, label: "Ficha Brutal"
  });
  game.system.brutal = {
    openPanel,
    roll: (action, attribute) => rollTest(selectedActor(), action, attribute),
    request: action => requestAction(selectedActor(), action)
  };
});

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!game.user.isGM || !message.getFlag(ID, "effect")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = Boolean(message.getFlag(ID, "applied"));
  button.textContent = button.disabled ? "Aplicado" : "Aplicar efeito";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await directorOperation(() => updateFromCard(message)); }
    finally {
      button.disabled = Boolean(message.getFlag(ID, "applied"));
      if (button.disabled) button.textContent = "Aplicado";
    }
  });
  html.append(button);
});
