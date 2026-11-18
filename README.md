# Apot · essayage de la tenue (fit_app)

App web statique, gratuite, sans backend ni appel payant.
three 0.187 + three-mesh-bvh 0.9.18 vendorisés dans `vendor/` (import map, aucun build).

## Lancer (sur la box)
    ./serve_local.sh          # http://127.0.0.1:8765/index.html
Ne marche pas en `file://` (le navigateur bloque le chargement des .glb).

Une copie est aussi en ligne sur GitHub Pages : https://enudimmud.github.io/APOT-AVATAR/

## Fichiers
- `index.html`, `app.css`, `app.js` (scène, UI, caméra, placement, rig, traversées, sauvegarde/export), `sculpt.js` (sculpture, sommets soudés par position), `rig.js` (articulations, estimation, aperçu du skinning).
- `assets/corps_web.glb` (750 Ko) et `assets/tenue_web.glb` (2,4 Mo) : 50k triangles chacun, textures 2048 WebP, Draco. Faits par `tools/make_web_assets.py` (Blender, décimation) + gltf-transform (resize/webp/draco). Originaux `gen3d/meshy_apot_*_v10.glb` et `.blend` non modifiés.
- `tools/apply_state_to_hd.py` : reporte un état exporté (`.json`) sur la tenue Meshy **HD** et enregistre un **nouveau** .blend.
- `tools/apply_rig_to_hd.py` : lit la clé `rig` du même JSON, construit une armature sur une *copie* de `work/v10/apot_fit_jd_v2_corr.blend` et enregistre un **nouveau** .blend (pas de poids, le fichier source n'est pas ouvert ni modifié) :
  `blender -b --python fit_app/tools/apply_rig_to_hd.py -- etat.json sortie.blend`
- `test/e2e.mjs` et `test/e2e_rig.mjs` : tests Playwright (412×915 et 906×1088, vrais événements tactiles), captures dans `screens/`.

## Utilisation
- **Vue** : 1 doigt tourne, pincer zoome, 2 doigts déplacent. Boutons Face / Profil / Dos / ⟲.
- **Placer** : curseurs + boutons −/+ (maintenir pour répéter) pour position (cm), rotation (°), taille globale et par axe (%).
- **Sculpter** : Gonfler / Tirer / Pousser / Lisser, taille 0,5–15 cm, force, Symétrie X, 🔒 Caméra. Doigt sur la tenue = pinceau, à côté = caméra.
- **Rig** : les articulations (hanches, colonne, tête, bras, jambes, et les 3 phalanges de chaque doigt) sont placées au départ par une estimation depuis le corps. Touche une sphère pour la choisir, fais-la glisser pour la déplacer dans le plan de l'écran. Le curseur **Profondeur** (ou deux doigts de haut en bas) la déplace en profondeur. **Centrer dans le volume** la replace au milieu du corps le long du regard. **Symétrie X** est activée par défaut. La liste en bas sert pour les petites articulations des doigts. **Tester** applique des poses (bras levés, accroupi, tête tournée, poing fermé, marche) pour voir le corps et la tenue suivre ; **Repos** revient à la pose en A.
- **Affichage** : corps / tenue visibles, transparence, « zones qui traversent » (points du corps hors de la tenue en rouge).
- **↶ ↷** : 30 niveaux d'annulation (sculpture, placement et rig). **💾** : sauvegarde auto dans le navigateur (à chaque geste, au bout d'une seconde), export GLB, export état JSON (y compris le rig, dans l'espace local glTF du corps), **📂 Ouvrir un état** pour recharger un JSON. Au premier lancement (ou si le navigateur n'a pas de sauvegarde), l'ajustement **V2** validé est déjà en place. « Revenir à l'ajustement V2 » le restaure ; « Tenue d'origine Meshy » remet la tenue brute.
