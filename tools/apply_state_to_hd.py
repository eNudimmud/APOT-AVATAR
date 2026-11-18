# Free, local. Apply a fit_app state (.json from "Télécharger l'état") to the ORIGINAL HD Meshy outfit.
# Opens work/v10/apot_tenue_meshy.blend (HD body + HD outfit, rough fit), transfers the sculpt deltas
# from the 50k web mesh to the 206k HD outfit (inverse-distance weighted, k nearest), sets the outfit
# transform from the app, and saves a NEW .blend (never overwrites the inputs).
# Usage: blender -b work/v10/apot_tenue_meshy.blend --python fit_app/tools/apply_state_to_hd.py -- state.json out.blend
#
# Coordinate spaces (confirmed against fit_app/app.js and the HD blend):
#   pos/rest are glTF Y-up, in the outfit mesh's LOCAL space (geometry.attributes.position).
#   Convert to Blender local with (x, y, z)_glTF -> (x, -z, y)_Blender before KD transfer onto v.co.
#   m and bodyMatrix are column-major three.js node matrices in the scene (Y-up). After the app
#   reparents each mesh to the scene, mesh.matrix == the glTF world matrix. Convert with
#   C * M * C^-1 where C is the Y-up -> Z-up change-of-basis. bodyMatrix is applied to the body
#   only if it differs from the blend (JD did not move the body in the exported states).
import bpy, json, sys, base64, struct, os
from mathutils import Vector, Matrix
from mathutils.kdtree import KDTree

args = sys.argv[sys.argv.index('--') + 1:]
state_path, out = os.path.abspath(args[0]), os.path.abspath(args[1])
state = json.load(open(state_path))
f32 = lambda b: struct.unpack('<%df' % (len(base64.b64decode(b)) // 4), base64.b64decode(b))
rest, pos = f32(state['rest']), f32(state['pos'])
G = len(rest) // 3
# glTF (x, y, z) -> Blender (x, -z, y)
g2b = lambda x, y, z: Vector((x, -z, y))
moved = [i for i in range(G) if rest[3*i:3*i+3] != pos[3*i:3*i+3]]
print('groups', G, 'moved', len(moved), 'space', state.get('space', '(missing)'))
kd = KDTree(G)
for i in range(G): kd.insert(g2b(*rest[3*i:3*i+3]), i)
kd.balance()
delta = [g2b(*pos[3*i:3*i+3]) - g2b(*rest[3*i:3*i+3]) for i in range(G)]

def mat_from_colmajor(m):
    return Matrix([[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [0, 0, 0, 1]])
# transform: column-major glTF / three.js matrix -> Blender: C * M * C^-1
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
def gltf_world_to_blender(m):
    return C @ mat_from_colmajor(m) @ C.inverted()

def mat_close(A, B, tol=1e-6):
    return all(abs(A[i][j] - B[i][j]) <= tol for i in range(4) for j in range(4))

body = bpy.data.objects.get('APOT_Nu_Meshy_v10_raw')
if body is None:
    raise SystemExit('missing body APOT_Nu_Meshy_v10_raw')
if 'bodyMatrix' in state:
    body_mw = gltf_world_to_blender(state['bodyMatrix'])
    if mat_close(body.matrix_world, body_mw):
        print('bodyMatrix matches blend body (body was not moved in the app); leaving body transform as-is')
    else:
        old = body.matrix_world.copy()
        body.matrix_world = body_mw
        print('WARN bodyMatrix differs from blend body; applied app body transform')
        print('  was loc', tuple(round(x, 6) for x in old.to_translation()), 'scale', tuple(round(x, 6) for x in old.to_scale()))
        print('  now loc', tuple(round(x, 6) for x in body.location), 'scale', tuple(round(x, 6) for x in body.scale))
else:
    print('WARN state has no bodyMatrix; leaving body transform as-is')

o = bpy.data.objects['APOT_Tenue_Meshy_v10_raw']
me = o.data
# sanity: rest groups should sit on the HD local mesh
sample = min(200, G)
acc = 0.0
for i in range(0, G, max(1, G // sample)):
    acc += kd.find(g2b(*rest[3*i:3*i+3]))[2]
# find from a rest point to itself is 0; check HD verts instead
kd_hd = KDTree(len(me.vertices))
for i, v in enumerate(me.vertices): kd_hd.insert(v.co, i)
kd_hd.balance()
nn = [kd_hd.find(g2b(*rest[3*i:3*i+3]))[2] for i in range(0, G, max(1, G // sample))]
print('rest-to-HD nearest (sample) mean', round(sum(nn) / len(nn), 6), 'max', round(max(nn), 6))

K = 6
for v in me.vertices:
    hits = kd.find_n(v.co, K)
    ws, acc = 0.0, Vector()
    for co, i, d in hits:
        w = 1.0 / (d * d + 1e-8); ws += w; acc += delta[i] * w
    if ws: v.co += acc / ws
me.update()
o.matrix_world = gltf_world_to_blender(state['m'])
o.name = 'APOT_Tenue_ajustee_HD'
bpy.context.view_layer.update()
os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
print('SAVED', out, 'loc', tuple(round(x, 4) for x in o.location), 'scale', tuple(round(x, 4) for x in o.scale),
      'rot_deg', tuple(round(x, 3) for x in [a * 180.0 / 3.141592653589793 for a in o.matrix_world.to_euler()]))
