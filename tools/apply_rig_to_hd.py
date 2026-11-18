# Build an armature from a fit_app export JSON (key "rig") on a COPY of
# work/v10/apot_fit_jd_v2_corr.blend, and save a NEW .blend. No weights.
# The source blend is never opened in place and is never overwritten.
#
# Usage:
#   blender -b --python fit_app/tools/apply_rig_to_hd.py -- state.json out.blend
#   blender -b --python fit_app/tools/apply_rig_to_hd.py -- state.json out.blend /path/to/source.blend
#
# Joint positions are glTF Y-up, in the body mesh's LOCAL space, plus bodyMatrix
# (column-major three.js / glTF). Convert (x, y, z)_glTF -> (x, -z, y)_Blender
# after applying bodyMatrix, same as tools/apply_state_to_hd.py.
import bpy, json, sys, os, shutil, tempfile
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
APOT = os.path.abspath(os.path.join(HERE, '..', '..'))
DEFAULT_SRC = os.path.join(APOT, 'work', 'v10', 'apot_fit_jd_v2_corr.blend')

args = sys.argv[sys.argv.index('--') + 1:]
if len(args) < 2:
    raise SystemExit('usage: blender -b --python apply_rig_to_hd.py -- state.json out.blend [source.blend]')
state_path, out = os.path.abspath(args[0]), os.path.abspath(args[1])
src = os.path.abspath(args[2]) if len(args) > 2 else DEFAULT_SRC
state = json.load(open(state_path))
rig = state.get('rig')
if not rig or not rig.get('joints'):
    raise SystemExit('JSON has no rig.joints (export from the app in Rig mode, bouton 💾)')

# --- open a temporary copy of the source, never the live file
if not os.path.isfile(src):
    raise SystemExit('missing source blend: ' + src)
tmpdir = tempfile.mkdtemp(prefix='apot_rig_')
src_copy = os.path.join(tmpdir, 'src.blend')
shutil.copy2(src, src_copy)
print('OPEN copy of', src, '->', src_copy, 'size', os.path.getsize(src_copy))
bpy.ops.wm.open_mainfile(filepath=src_copy)

def mat_from_colmajor(m):
    return Matrix([[m[0], m[4], m[8], m[12]],
                   [m[1], m[5], m[9], m[13]],
                   [m[2], m[6], m[10], m[14]],
                   [0, 0, 0, 1]])

# glTF / three.js Y-up world -> Blender Z-up world: C * M * C^-1 for matrices,
# and for a point: (x, y, z) -> (x, -z, y)
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))

def gltf_world_to_blender_mat(m):
    return C @ mat_from_colmajor(m) @ C.inverted()

def gltf_point_world_to_blender(x, y, z):
    return Vector((x, -z, y))

body_mat_gltf = rig.get('bodyMatrix') or state.get('bodyMatrix')
if not body_mat_gltf:
    raise SystemExit('rig/bodyMatrix missing')
Mbody = mat_from_colmajor(body_mat_gltf)

def joint_blender_world(p):
    # p is body-local glTF; world_gltf = bodyMatrix * p
    wp = Mbody @ Vector((p[0], p[1], p[2], 1.0))
    return gltf_point_world_to_blender(wp[0], wp[1], wp[2])

# Prefer the untouched original body if present (the "raw" copy may have been tucked).
body = (bpy.data.objects.get('APOT_Nu_Meshy_v10_original')
        or bpy.data.objects.get('APOT_Nu_Meshy_v10_raw')
        or next((o for o in bpy.data.objects if o.type == 'MESH' and 'Nu' in o.name), None))
if body is None:
    raise SystemExit('no body mesh found in blend')
print('BODY', body.name, 'loc', tuple(round(x, 5) for x in body.location),
      'scale', tuple(round(x, 5) for x in body.scale))

joints = rig['joints']
by = {j['name']: j for j in joints}
# primary child: first listed child, with a preferred chain
PREFERRED = {
    'hips': 'spine', 'spine': 'chest', 'chest': 'neck', 'neck': 'head',
    'shoulder.L': 'upper_arm.L', 'upper_arm.L': 'forearm.L', 'forearm.L': 'hand.L', 'hand.L': 'middle.01.L',
    'shoulder.R': 'upper_arm.R', 'upper_arm.R': 'forearm.R', 'forearm.R': 'hand.R', 'hand.R': 'middle.01.R',
    'thigh.L': 'shin.L', 'shin.L': 'foot.L', 'foot.L': 'toe.L',
    'thigh.R': 'shin.R', 'shin.R': 'foot.R', 'foot.R': 'toe.R',
}
for S in ('L', 'R'):
    for f in ('thumb', 'index', 'middle', 'ring', 'pinky'):
        PREFERRED[f'{f}.01.{S}'] = f'{f}.02.{S}'
        PREFERRED[f'{f}.02.{S}'] = f'{f}.03.{S}'
children = {}
for j in joints:
    children.setdefault(j.get('parent'), []).append(j['name'])

def tail_of(name):
    pref = PREFERRED.get(name)
    if pref and pref in by:
        return joint_blender_world(by[pref]['p'])
    ch = [c for c in children.get(name, []) if c in by]
    if ch:
        return joint_blender_world(by[ch[0]]['p'])
    h = joint_blender_world(by[name]['p'])
    if name == 'head' and body is not None:
        top = max((body.matrix_world @ Vector(c)).z for c in body.bound_box)
        return Vector((h.x, h.y, top))
    par = by[name].get('parent')
    if par and par in by:
        ph = joint_blender_world(by[par]['p'])
        d = h - ph
        if d.length > 1e-8:
            return h + d.normalized() * (0.04 if name.startswith('toe') else 0.03)
    return h + Vector((0, 0, 0.04))

# hips tail points down (Blender -Z) so it does not steal the spine's connect
def hips_tail(h):
    return Vector((h.x, h.y, h.z - 0.08))

if 'APOT_Rig' in bpy.data.objects:
    bpy.data.objects.remove(bpy.data.objects['APOT_Rig'], do_unlink=True)
if 'APOT_Rig' in bpy.data.armatures:
    bpy.data.armatures.remove(bpy.data.armatures['APOT_Rig'])

arm_d = bpy.data.armatures.new('APOT_Rig')
arm = bpy.data.objects.new('APOT_Rig', arm_d)
bpy.context.collection.objects.link(arm)
arm.show_in_front = True
arm_d.display_type = 'OCTAHEDRAL'
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
EB = arm_d.edit_bones
FWD = Vector((0, -1, 0))
UP = Vector((0, 0, 1))

# create bones parent-first (joints are already listed that way in the app export)
created = []
for j in joints:
    name, parent, p = j['name'], j.get('parent'), j['p']
    if name in EB:
        continue
    h = joint_blender_world(p)
    t = hips_tail(h) if name == 'hips' else tail_of(name)
    if (t - h).length < 1e-6:
        t = h + Vector((0, 0, 0.03))
    b = EB.new(name)
    b.head, b.tail = h, t
    # arms / fingers / clavicle: roll along up; others face forward
    roll_vec = UP if any(k in name for k in ('shoulder', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky', 'foot', 'toe')) else FWD
    try:
        b.align_roll(roll_vec)
    except Exception:
        pass
    if parent and parent in EB:
        b.parent = EB[parent]
        # connect when the child's head sits on the parent's tail
        b.use_connect = (EB[parent].tail - h).length < 1e-4
    created.append(name)

bpy.ops.object.mode_set(mode='OBJECT')
print('BONES', len(arm_d.bones), 'created', len(created))
if 'hips' in arm_d.bones:
    hips_w = arm.matrix_world @ arm_d.bones['hips'].head_local
    print('hips world', tuple(round(x, 5) for x in hips_w))
# sanity: hips should fall inside the body bbox
bb = [body.matrix_world @ Vector(c) for c in body.bound_box]
mins = Vector((min(p[i] for p in bb) for i in range(3)))
maxs = Vector((max(p[i] for p in bb) for i in range(3)))
print('body world bbox', tuple(round(x, 4) for x in mins), '→', tuple(round(x, 4) for x in maxs))
if 'hips' in arm_d.bones:
    hw = arm.matrix_world @ arm_d.bones['hips'].head_local
    inside = all(mins[i] - 0.05 <= hw[i] <= maxs[i] + 0.05 for i in range(3))
    print('hips inside body bbox', inside)

os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
print('SAVED', out, 'bytes', os.path.getsize(out))
# do not save anything back to the temp copy / source
