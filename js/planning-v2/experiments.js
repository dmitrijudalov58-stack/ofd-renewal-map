(function(root){
 'use strict';
 const P=root.Planning2,states=new Map(),KEY='ofd.planning2.oksana.v1';
 function saved(){try{return P.normalizeParams(JSON.parse(localStorage.getItem(KEY)));}catch(e){return P.defaults();}}
 for(const kind of [1,2])root.OFDWidgets.WIDGETS['pl2-experiment'+kind]={
  title:'Эксперимент №'+kind,type:'таблица',scope:kind===1?'план':'ретро',span:true,defaultH:14,
  render:function(model,ctx,id){
   root.OFDPlanning2.instances.get(id)?.destroy();
   const filters=states.get(id)||{};states.set(id,filters);
   const state={params:saved(),ofd:null,onec:null,promos:null,plan:null};
   const box=document.createElement('div');box.className='planning2 p2-experiment';box.dataset.experiment=kind;
   const fields=kind===1?[['year','Год плана','number'],['retroFrom','Ретро с','date'],['retroTo','Ретро по','date'],['asOf','Срез на начало дня','date']]:[['retroFrom','Ретро с','date'],['retroTo','Ретро по','date'],['asOf','Срез на начало дня','date']];
   box.innerHTML='<div class="controls">'+fields.map(([key,label,type])=>'<label>'+label+'<input data-experiment-param="'+key+'" type="'+type+'"'+(type==='number'?' min="2000" max="2100"':'')+'></label>').join('')+'</div><p class="tiny">Период можно менять отдельно от основного плана. Списки активности общие для двух экспериментов; повторная загрузка заменяет список в обоих.</p><section data-experiment-view></section>';
   const panel=root.Planning2PlanCheckUI.mount(box.querySelector('[data-experiment-view]'),()=>state,{experiment:kind});
   function sync(){
    state.ofd=root.OFDState?.planning2Data?.ledger||null;
    state.onec=root.OFDWidgets.ofd1cGetState()?.planning2Data?.ledger||null;
    state.promos=root.OFDPlanning2.promoData;
    state.params={...saved(),...filters};
    if(!state.params.asOf&&state.ofd?.maxStart!=null&&!Object.hasOwn(filters,'asOf'))state.params.asOf=P.iso(Math.floor(state.ofd.maxStart));
    for(const [key]of fields)box.querySelector('[data-experiment-param="'+key+'"]').value=state.params[key];
    panel.sync();
   }
   box.querySelectorAll('[data-experiment-param]').forEach(el=>el.onchange=()=>{filters[el.dataset.experimentParam]=el.type==='number'?+el.value:el.value;sync();});
   root.addEventListener('planning2-params',sync);
   const api={kind,state,planCheck:panel,syncShared:sync,destroy:()=>{root.removeEventListener('planning2-params',sync);panel.destroy();}};
   root.OFDPlanning2.instances.set(id,api);sync();return box;
  },
  onRemove:function(id){root.OFDPlanning2.instances.get(id)?.destroy();root.OFDPlanning2.instances.delete(id);states.delete(id);}
 };
})(window);
