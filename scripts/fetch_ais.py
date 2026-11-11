"""Fetch + thin the public inputs (run once; outputs are committed in raw/).

1. AIS: Danish Maritime Authority open AIS archive (one day, ~610 MB zip):
     curl -o ais.zip http://aisdata.ais.dk.s3.eu-central-1.amazonaws.com/aisdk-2026-10-21.zip
   then `python3 scripts/fetch_ais.py` keeps Class A fixes inside the Kattegat/Skagerrak
   box (56.9-58.1 N, 10.2-12.4 E), one fix per vessel per 5 minutes -> raw/kat.csv,
   and per-MMSI static fields -> raw/static.json. Delete ais.zip afterwards.
2. Weather (20 grid points, 20-21 Oct 2026):
     https://archive-api.open-meteo.com/v1/archive?...&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms
     https://marine-api.open-meteo.com/v1/marine?...&hourly=ocean_current_velocity,ocean_current_direction&cell_selection=sea
   saved as raw/wind.json and raw/cur.json (see README for the exact point list).
"""
import zipfile, io, csv, json, datetime
z=zipfile.ZipFile('ais.zip'); f=io.TextIOWrapper(z.open(z.namelist()[0]),encoding='utf-8',errors='replace')
r=csv.reader(f); hdr=next(r)
LAT0,LAT1,LON0,LON1=56.9,58.1,10.2,12.4
last={}; static={}; out=open('raw/kat.csv','w'); w=csv.writer(out); n=0
for row in r:
    if row[1]!='Class A': continue
    try: la=float(row[3]); lo=float(row[4])
    except: continue
    if not(LAT0<=la<=LAT1 and LON0<=lo<=LON1): continue
    m=row[2]; t=row[0]
    ts=int(datetime.datetime.strptime(t,'%d/%m/%Y %H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp())
    st=static.setdefault(m,{})
    for k,i in (('name',12),('type',13),('len',16),('imo',10),('cs',11),('dest',19),('draught',18)):
        v=row[i]
        if v and v not in('Unknown','Undefined'): st[k]=v
    b=ts//300
    if last.get(m)==b: continue
    last[m]=b
    w.writerow([m,ts,round(la,5),round(lo,5),row[7],row[8],row[5]]); n+=1
out.close(); json.dump(static,open('raw/static.json','w'))
print(n,len(static))
