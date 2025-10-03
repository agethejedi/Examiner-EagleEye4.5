async function fakeSosFetch(name, state){return {state,query:name,results:[{entityName:name+' Holdings LLC',status:'Active',formed:'2019-06-14',id:state+'-0012345'},{entityName:name+' Services Inc',status:'Forfeited',formed:'2016-02-01',id:state+'-0099887'}]};}
export async function lookupSOS({name,state}){if(!name){return {error:'Enter a business name'};}return await fakeSosFetch(name,state);}
