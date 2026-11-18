# Free, local. Apply a fit_app state (.json from "Télécharger l'état") to the ORIGINAL HD Meshy outfit.
# Opens work/v10/apot_tenue_meshy.blend (HD body + HD outfit, rough fit), transfers the sculpt deltas
# from the 50k web mesh to the 206k HD outfit (inverse-distance weighted, k nearest), sets the outfit
# transform from the app, and saves a NEW .blend (never overwrites the inputs).
# Usage: blender -b work/v10/apot_tenue_meshy.blend --python fit_app/tools/apply_state_to_hd.py -- state.json out.blend
import bpy, json, sys, base64, struct
from mathutils import Vector, Matrix
from mathutils.kdtree import KDTree

args = sys.argv[sys.argv.index('--') + 1:]
state = json.load(open(args[0])); out = args[1]
f32 = lambda b: struct.unpack('<%df' % (len(base64.b64decode(b)) // 4), base64.b64decode(b))
rest, pos = f32(state['rest']), f32(state['pos'])
G = len(rest) // 3
# glTF (x, y, z) -> Blender (x, -z, y)
g2b = lambda x, y, z: Vector((x, -z, y))
moved = [i for i in range(G) if rest[3*i:3*i+3] != pos[3*i:3*i+3]]
print('groups', G, 'moved', len(moved))
kd = KDTree(G)
for i in range(G): kd.insert(g2b(*rest[3*i:3*i+3]), i)
kd.balance()
delta = [g2b(*pos[3*i:3*i+3]) - g2b(*rest[3*i:3*i+3]) for i in range(G)]

o = bpy.data.objects['APOT_Tenue_Meshy_v10_raw']
me = o.data
K = 6
for v in me.vertices:
    hits = kd.find_n(v.co, K)
    ws, acc = 0.0, Vector()
    for co, i, d in hits:
        w = 1.0 / (d * d + 1e-8); ws += w; acc += delta[i] * w
    if ws: v.co += acc / ws
me.update()
# transform: column-major glTF matrix -> Blender: C * M * C^-1
m = state['m']; M = Matrix([[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [0, 0, 0, 1]])
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
o.matrix_world = C @ M @ C.inverted()
o.name = 'APOT_Tenue_ajustee_HD'
bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
print('SAVED', out, 'loc', tuple(round(x, 4) for x in o.location), 'scale', tuple(round(x, 4) for x in o.scale))
