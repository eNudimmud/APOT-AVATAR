# Apot · essayage de la tenue (fit_app)

App web statique, gratuite, sans backend ni appel payant, à usage **local** uniquement (rien n'est publié).
three 0.187 + three-mesh-bvh 0.9.18 vendorisés dans `vendor/` (import map, aucun build).

## Lancer (sur la box)
    ./serve_local.sh          # http://127.0.0.1:8765/index.html
Ne marche pas en `file://` (le navigateur bloque le chargement des .glb).

## Fichiers
- `index.html`, `app.css`, `app.js` (scène, UI, caméra, placement, traversées, sauvegarde/export), `sculpt.js` (moteur de sculpture, sommets soudés par position pour ne jamais déchirer les coutures UV).
- `assets/corps_web.glb` (750 Ko) et `assets/tenue_web.glb` (2,4 Mo) : 50k triangles chacun, textures 2048 WebP, Draco. Faits par `tools/make_web_assets.py` (Blender, décimation) + gltf-transform (resize/webp/draco). Originaux `gen3d/meshy_apot_*_v10.glb` et `.blend` non modifiés.
- `tools/apply_state_to_hd.py` : reporte un état exporté (`.json`) sur la tenue Meshy **HD** (206k tris) et enregistre un **nouveau** .blend :
  `blender -b work/v10/apot_tenue_meshy.blend --python fit_app/tools/apply_state_to_hd.py -- etat.json sortie.blend`
- `test/e2e.mjs` : test Playwright (412×915 et 906×1088, vrais événements tactiles), captures dans `screens/`.

## Utilisation
- **Vue** : 1 doigt tourne, pincer zoome, 2 doigts déplacent. Boutons Face / Profil / Dos / ⟲.
- **Placer** : curseurs + boutons −/+ (maintenir pour répéter) pour position (cm), rotation (°), taille globale et par axe (%).
- **Sculpter** : Gonfler / Tirer / Pousser / Lisser, taille 0,5–15 cm, force, Symétrie X, 🔒 Caméra. Doigt sur la tenue = pinceau, à côté = caméra.
- **Affichage** : corps / tenue visibles, transparence, « zones qui traversent » (points du corps hors de la tenue en rouge).
- **↶ ↷** : 30 niveaux d'annulation (sculpture et placement). **💾** : sauvegarde auto dans le navigateur, export GLB, export état JSON.
