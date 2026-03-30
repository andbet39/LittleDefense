import json, struct
path = 'assets/Adventurer/Characters/gltf/Barbarian.glb'
with open(path, 'rb') as f:
    f.read(12)
    cl = struct.unpack('<I', f.read(4))[0]
    f.read(4)
    d = json.loads(f.read(cl))
for i, n in enumerate(d['nodes']):
    name = n.get('name', '')
    if 'hand' in name.lower() or 'root' in name.lower():
        t = n.get('translation', '-')
        s = n.get('scale', '-')
        r = n.get('rotation', '-')
        c = n.get('children', '-')
        print(f'{i}: {name}  t={t}  s={s}  r={r}  children={c}')
