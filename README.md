# VOLLEYLAB V0.17 — fluidité du 2v2 en ligne

Cette version conserve le prototype V0.16 et les salons privés, avec ces améliorations :

- **30 états serveur/seconde** (anciennement 20) ; simulation serveur toujours à 60 Hz.
- **Interpolation des joueurs distants et du ballon** entre les états reçus pour éviter les à-coups.
- **Prédiction du déplacement, du saut et du plongeon local** pour répondre au clavier immédiatement. La physique officielle et les scores restent validés par le serveur.
- **Correction douce** des écarts avec le serveur, même si la connexion présente de la latence.
- **Mesure du ping et des FPS** dans `Options → Fluidité`.
- **Qualité graphique automatique** : baisse progressive de la résolution si la fréquence d'images ralentit ; modes Performance / Qualité sélectionnables.
- Modes solo et aide masquée par défaut conservés.

## Déploiement Render

Le service `volleylab-online` pointe vers le dépôt `iksqua/volleylab`, branche `main`, Node >=22, commande `npm start`.
Remplacer les fichiers de la racine GitHub par ceux de ce dossier (`index.html`, `style.css`, `game.js`, `server.mjs`, `audio.js`, `package.json`, `README.md`, `tests/online.test.mjs`). L'ancienne `render.yaml` peut rester.
Le déploiement automatique de Render devrait redémarrer après un nouveau commit.

L'URL reste `https://volleylab-online.onrender.com`. Il n'est pas nécessaire de créer un autre service ni d'acheter un hébergement.

## Limites

Cette optimisation ne garantit pas 60 FPS sur tous les ordinateurs ou toutes les connexions. La balle est affichée légèrement en retard (tampon d'interpolation ~100 ms) pour améliorer sa fluidité, tandis que le déplacement du joueur local utilise la prédiction. Un seul serveur Render gratuit reste susceptible d'être mis en veille après inactivité.

## Tests

`npm test` pour le salon à quatre personnes, puis `npm run check`.
