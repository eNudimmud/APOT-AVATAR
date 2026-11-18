# Free, local: decimate the validated Meshy v10 body + outfit for the fit app.
# Reads work/v10/apot_tenue_meshy.blend (rough fit: body 0.89 m, outfit 0.95 m), never saves it.
import bpy, bmesh, sys
TARGET = 50000
OUT = '/tmp/fitapp/'
names = {'APOT_Nu_Meshy_v10_raw': 'corps', 'APOT_Tenue_Meshy_v10_raw': 'tenue'}
for oname, short in names.items():
    o = bpy.data.objects[oname]
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.to_mesh(o.data); bm.free()
    n0 = len(o.data.polygons)
    m = o.modifiers.new('dec', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = TARGET / n0; m.use_collapse_triangulate = True
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier='dec')
    print('DEC', short, n0, '->', len(o.data.polygons), 'verts', len(o.data.vertices))
    o.name = 'APOT_' + short
    bpy.ops.export_scene.gltf(filepath=OUT + short + '_raw.glb', export_format='GLB', use_selection=True,
                              export_apply=False, export_yup=True, export_image_format='AUTO', export_materials='EXPORT')
