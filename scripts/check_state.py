import sqlite3, json

db = sqlite3.connect('data/state.sqlite')
tables = [t[0] for t in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print('Tables:', tables)

# Also check state.json
import os
state_path = 'data/state.json'
if os.path.exists(state_path):
    state = json.load(open(state_path, encoding='utf-8'))
    preds = state.get('predictions', {})
    print('\nstate.json predictions:', len(preds))
    ll = state.get('memory', {}).get('learningLog', [])
    print('state.json learningLog:', len(ll))
    for i, e in enumerate(ll[:3]):
        print(i, json.dumps({'gamePk': e.get('gamePk'), 'score': e.get('score')}))
else:
    print('No state.json found')

# Check each table for memory-related data
for table in tables:
    try:
        cols = [c[1] for c in db.execute(f'PRAGMA table_info({table})').fetchall()]
        count = db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
        print(f'\nTable {table}: {count} rows, cols: {cols}')
        if any('learning' in c.lower() or 'memory' in c.lower() for c in cols):
            row = db.execute(f'SELECT * FROM {table} LIMIT 1').fetchone()
            if row:
                for c, v in zip(cols, row):
                    if 'learning' in c.lower() or 'memory' in c.lower():
                        data = json.loads(v) if isinstance(v, str) and v.startswith('[') else v
                        if isinstance(data, list):
                            print(f'  {c}: {len(data)} entries')
                            for j, e in enumerate(data[:2]):
                                if isinstance(e, dict):
                                    print(f'    {j}: gamePk={e.get("gamePk")} score={e.get("score")}')
                        else:
                            print(f'  {c}: {str(v)[:200]}')
    except Exception as ex:
        print(f'Error on {table}: {ex}')

db.close()