const ATTRS={forca:'Força',agilidade:'Agilidade',vigor:'Vigor',mental:'Mental',inteligencia:'Inteligência'};
const STEREOTYPES={nerd:['inteligencia','agilidade',6],atleta:['forca','agilidade',2],esbelto:['tesao','vigor',4],covarde:['vigor','agilidade',1],corajoso:['forca','mental',7],alivio:['mental','shots',4],curioso:['mental','vigor',3],relaxado:['tesao','shots',7],santo:['mental','agilidade',3],inocente:['tesao','shots',7],mentor:['mental','inteligencia',5],valentao:['forca','vigor',3],cetico:['inteligencia','shots',3],estiloso:['inteligencia','agilidade',2],mauagouro:['agilidade','vigor',5]};
class BrutalActorData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const { BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;
    const text = () => new StringField({ blank: true, initial: "" });
    const number = (initial = 0) => new NumberField({ nullable: false, initial });
    const attributes = Object.fromEntries(Object.keys(ATTRS).map(key => [
      key, new SchemaField({ trained: new BooleanField(), bonus: number() })
    ]));
    return {
      attributes: new SchemaField(attributes),
      pool: number(6),
      shots: number(),
      tesao: number(),
      initiative: number(),
      cut: number(),
      shotsTrained: new BooleanField(),
      tesaoTrained: new BooleanField(),
      stereotype: text(),
      bonusAttribute: text(),
      ability: text(),
      background: text(),
      equipment: text()
    };
  }
}

class BrutalActor extends foundry.documents.Actor {
 async rollAttribute(key){if(!ATTRS[key])return;const s=this.system;const max=Math.max(0,Number(s.pool)||0);if(!max)return ui.notifications.warn('Você não tem dados disponíveis.');const content=`<div class="form-group"><label>Dados (máx. ${max})</label><input name="dice" type="number" min="1" max="${max}" value="1"></div><div class="form-group"><label>Alvo por dado</label><input name="target" type="number" min="1" max="6" value="3"></div>`;const result=await foundry.applications.api.DialogV2.wait({rejectClose:false,window:{title:`Teste de ${ATTRS[key]}`},content,buttons:[{action:'roll',label:'Rolar',default:true,callback:(event,button)=>({dice:Number(button.form.elements.dice.value),target:Number(button.form.elements.target.value)})},{action:'cancel',label:'Cancelar'}]});if(!result||!Number.isInteger(result.dice)||result.dice<1||result.dice>max||!Number.isInteger(result.target)||result.target<1||result.target>6)return;const bonus=Math.min(2,Math.max(0,Number(s.attributes[key]?.bonus)||0)+(s.attributes[key]?.trained?1:0));const roll=await new Roll(`${result.dice}d6`).evaluate();const faces=roll.dice[0].results.map(r=>r.result);const successes=faces.filter(n=>n+bonus>=result.target).length;const failures=result.dice-successes;await this.update({'system.pool':max-failures});await roll.toMessage({speaker:ChatMessage.getSpeaker({actor:this}),flavor:`<strong>${ATTRS[key]}</strong> · alvo ${result.target} · bônus +${bonus}<br>Sucessos: ${successes} · Falhas: ${failures} · Dados enviados ao Assassino: ${failures}`});}
 async addShot(amount=1){let shots=Math.max(0,Number(this.system.shots)||0)+amount,tesao=Math.max(0,Number(this.system.tesao)||0),pool=Math.max(0,Number(this.system.pool)||0);const shotLimit=this.system.shotsTrained?2:3,tesaoLimit=this.system.tesaoTrained?2:3;while(shots>=shotLimit){shots-=shotLimit;tesao++;}while(tesao>=tesaoLimit){tesao-=tesaoLimit;pool++;}await this.update({'system.shots':shots,'system.tesao':tesao,'system.pool':pool});}
}
const { api, apps, sheets } = foundry.applications;
class BrutalSheet extends api.HandlebarsApplicationMixin(sheets.ActorSheetV2) {
 static DEFAULT_OPTIONS={tag:"form",classes:['brutal-sheet'],position:{width:700,height:760},window:{resizable:true},form:{submitOnChange:true,closeOnSubmit:false},actions:{roll:BrutalSheet.rollAction,shot:BrutalSheet.shotAction}};
 static PARTS={main:{template:'systems/brutal-rpg/templates/sheet.hbs'}};
 async _prepareContext(options){const ctx=await super._prepareContext(options);return {...ctx,actor:this.actor,system:this.actor.system,attributes:Object.entries(ATTRS).map(([key,label])=>({key,label,data:this.actor.system.attributes?.[key]??{}})),stereotypes:Object.entries(STEREOTYPES).map(([key,value])=>({key,label:key.replace(/(^|\s)\S/g,x=>x.toUpperCase()),selected:this.actor.system.stereotype===key}))};}
 static async rollAction(event,button){await this.actor.rollAttribute(button.dataset.attribute);}
 static async shotAction(){await this.actor.addShot(1);}
 async _onChangeForm(formConfig, event) {
   const input = event.target;
   if (input?.name !== "system.stereotype") return super._onChangeForm(formConfig, event);
   if (!this.isEditable || !Object.hasOwn(STEREOTYPES, input.value)) return;
   const [first, second, initiative] = STEREOTYPES[input.value];
   const trained = new Set([first, second]);
   const changes = {
     "system.stereotype": input.value,
     "system.initiative": initiative,
     "system.shotsTrained": trained.has("shots"),
     "system.tesaoTrained": trained.has("tesao")
   };
   for (const key of Object.keys(ATTRS)) {
     changes[`system.attributes.${key}.trained`] = trained.has(key);
   }
   await this.actor.update(changes);
 }
}
Hooks.once("init", () => {
  const types = ["personagem", "assassino"];
  CONFIG.Actor.documentClass = BrutalActor;
  for (const type of types) CONFIG.Actor.dataModels[type] = BrutalActorData;
  apps.DocumentSheetConfig.registerSheet(foundry.documents.Actor, game.system.id, BrutalSheet, {
    types,
    makeDefault: true,
    label: "Ficha Brutal"
  });
});
