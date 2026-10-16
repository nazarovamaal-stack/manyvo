from pathlib import Path
import json,math,sqlite3,subprocess,sys
root=Path(__file__).resolve().parent.parent
path=root/'data/manyvo.sqlite3'
if not path.exists():
    raise SystemExit('No legacy SQLite database to import.')
command=['docker','compose','exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','manyvo','-d','manyvo']
def sql(statement):
    return subprocess.run(command+['-At'],input=statement,text=True,capture_output=True,check=True).stdout.strip()
with path.open('rb') as file:
    if file.read(16)!=b'SQLite format 3\x00':raise SystemExit('Unexpected database format.')
exists=sql("SELECT to_regclass('public.users') IS NOT NULL;")
if exists=='f':
    sql((root/'backend/internal/platform/schema.sql').read_text())
if sql('SELECT count(*) FROM users;')!='0':
    raise SystemExit('Target database is not empty. No changes were made.')
def value(v):
    if v is None:return 'NULL'
    if type(v) is bool:return 'true' if v else 'false'
    if type(v) in (int,float):
        if not math.isfinite(v):raise ValueError('Non-finite database value')
        return str(v)
    return "'"+str(v).replace("'","''")+"'"
columns={
'users':['id','email','name','role','age','country','password_hash'],
'studies':['id','owner_id','title','question','status','version','quota','age_min','age_max','country','created_at','published_at','deadline','closed_at','moderation_reason','moderation_provider','closure_reason'],
'options':['id','study_id','position','text','image'],
'answers':['id','study_id','user_id','personal_id','prediction_id','accepted_at'],
'ledger':['id','user_id','study_id','kind','amount','created_at'],
'events':['event_id','type','study_id','participant_id','at','fact_version'],
'facts':['study_id','version','metric','unit','start_date','end_date','is_rate','values_json','created_at']}
db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True)
db.row_factory=sqlite3.Row
db.execute('BEGIN')
lines=['BEGIN;','LOCK TABLE users IN ACCESS EXCLUSIVE MODE;',"DO $$ BEGIN IF EXISTS(SELECT 1 FROM users) THEN RAISE EXCEPTION 'Target is not empty'; END IF; END $$;"]
counts={}
for table,fields in columns.items():
    rows=db.execute('SELECT '+','.join(fields)+' FROM '+table).fetchall()
    counts[table]=len(rows)
    for row in rows:
        values=[bool(row[c]) if table=='facts' and c=='is_rate' else row[c] for c in fields]
        if table=='studies' and values[fields.index('status')]=='moderating':
            values[fields.index('status')]='draft'
            values[fields.index('version')]+=1
            values[fields.index('moderation_reason')]='Проверка прервана переносом базы. Отправьте материалы заново.'
        lines.append('INSERT INTO '+table+'('+','.join(fields)+') VALUES('+','.join(map(value,values))+');')
lines.append('COMMIT;')
sql('\n'.join(lines))
print('Imported legacy data:',json.dumps(counts))
print('The original SQLite database was kept unchanged. Sessions must sign in again.')
