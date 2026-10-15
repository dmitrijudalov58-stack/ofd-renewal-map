"""Обучение модели «шанс вернуться за 12 мес.» для раздела «Портрет клиента».
Запускается из build-portrait-data.js: python3 portrait-train.py <рабочая папка>
Нужны: pandas, numpy, scikit-learn (pip install).
"""
import pandas as pd,numpy as np,json,os,sys
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score,average_precision_score
from sklearn.inspection import permutation_importance
O=sys.argv[1].rstrip("/")+"/"   # рабочая папка: panel.csv, current.json -> current_p.csv, model.json
d=pd.read_csv(O+"panel.csv",dtype={"reg2":str,"ok2":str,"inn":str})
cats=["stype","chan","partner","center","form","reg2","ok2"]
num=["tsc","ten","nint","nkAll","nkE","tar","ncodes","bizage","emon","hasPh","hasEm","rrp","promo","relock","gapPrev","lastLen"]
feats=num+cats
for c in cats: d[c]=d[c].astype("category")
cm={c:list(d[c].cat.categories) for c in cats}
tr=d[d.S<"2024-01-01"];te=d[d.S>="2024-01-01"]
print("train",len(tr),tr.y.mean(),"test",len(te),te.y.mean())
def mk():return HistGradientBoostingClassifier(max_iter=300,learning_rate=0.06,max_leaf_nodes=31,min_samples_leaf=200,l2_regularization=1.0,categorical_features=[feats.index(c) for c in cats],random_state=0,early_stopping=True,validation_fraction=0.1)
Xtr=tr[feats].copy();Xte=te[feats].copy()
for X in (Xtr,Xte):
  for c in cats:X[c]=X[c].cat.codes
m=mk().fit(Xtr,tr.y);p=m.predict_proba(Xte)[:,1]
print("AUC test",roc_auc_score(te.y,p),"PR-AUC",average_precision_score(te.y,p),"base",te.y.mean())
# децили
te=te.assign(p=p);te["dec"]=pd.qcut(te.p.rank(method="first"),10,labels=False)
g=te.groupby("dec").agg(n=("y","size"),pred=("p","mean"),real=("y","mean"));g["lift"]=g.real/te.y.mean();print(g.round(4))
top=te.sort_values("p",ascending=False);
for q in (0.01,0.05,0.1):
  k=int(len(top)*q);print("top",q,"precision",top.y.iloc[:k].mean().round(4),"recall",(top.y.iloc[:k].sum()/te.y.sum()).round(3))
# важность
s=te.sample(60000,random_state=1);Xs=s[feats].copy()
for c in cats:Xs[c]=Xs[c].cat.codes
pi=permutation_importance(m,Xs,s.y,scoring="roc_auc",n_repeats=3,random_state=0,n_jobs=1)
imp=sorted(zip(feats,pi.importances_mean),key=lambda x:-x[1]);print([(a,round(b,4)) for a,b in imp])
# по одному признаку: время с ухода
te["tb"]=pd.cut(te.tsc,[0,1,2,3,6,12,24,48,200]);print(te.groupby("tb",observed=True).agg(n=("y","size"),real=("y","mean")).round(4))
te["kb"]=pd.cut(te.nkE,[0,1,2,5,9,100]);print(te.groupby("kb",observed=True).agg(n=("y","size"),real=("y","mean")).round(4))
te["nb"]=pd.cut(te.nint,[0,1,2,3,100]);print(te.groupby("nb",observed=True).agg(n=("y","size"),real=("y","mean")).round(4))
print(te.groupby("chan",observed=True).agg(n=("y","size"),real=("y","mean")).round(4))
print(te.groupby("stype",observed=True).agg(n=("y","size"),real=("y","mean")).round(4))
print(te.groupby("form",observed=True).agg(n=("y","size"),real=("y","mean")).round(4))
te["tab"]=pd.cut(te.tar,[-1,0,3,6,13,15,36]);print(te.groupby("tab",observed=True).agg(n=("y","size"),real=("y","mean")).round(4))
te["ten2"]=pd.cut(te.ten,[0,6,12,24,36,60,200]);print(te.groupby("ten2",observed=True).agg(n=("y","size"),real=("y","mean")).round(4))
print(te.groupby("hasPh").agg(n=("y","size"),real=("y","mean")).round(4),te.groupby("promo").agg(n=("y","size"),real=("y","mean")).round(4))
# финал: обучить на всей панели и оценить текущих
Xa=d[feats].copy()
for c in cats:Xa[c]=Xa[c].cat.codes
mf=mk().fit(Xa,d.y)
cur=json.load(open(O+"current.json"));cd=pd.DataFrame(cur["cur"])
Xc=cd[feats].copy()
for c in cats:
  Xc[c]=pd.Categorical(Xc[c].astype(str),categories=cm[c]).codes
cd["p"]=mf.predict_proba(Xc)[:,1]
print("current",len(cd),"mean p",cd.p.mean(),"quantiles",cd.p.quantile([.5,.9,.99]).round(4).tolist(),"p>=0.15",int((cd.p>=.15).sum()),"p>=0.3",int((cd.p>=.3).sum()))
cd[["inn","p"]].to_csv(O+"current_p.csv",index=False)
tbl=te.groupby("tb",observed=True).agg(n=("y","size"),real=("y","mean"))
mj={"auc":float(roc_auc_score(te.y,p)),"base":float(te.y.mean()),"trainRows":int(len(tr)),"testRows":int(len(te)),"allRows":int(len(d)),
 "dec":[[int(i),float(r.pred),float(r.real)] for i,r in g.iterrows()],
 "imp":[[a,float(b)] for a,b in imp],
 "tsc":[[str(i),int(r.n),float(r.real)] for i,r in tbl.iterrows()],
 "top":{str(q):[float(top.y.iloc[:int(len(top)*q)].mean()),float(top.y.iloc[:int(len(top)*q)].sum()/te.y.sum())] for q in (0.01,0.05,0.1)},
 "curQ":{"p15":int((cd.p>=.15).sum()),"p30":int((cd.p>=.3).sum()),"mean":float(cd.p.mean())}}
json.dump(mj,open(O+"model.json","w"),ensure_ascii=False)
