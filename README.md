# VOLLEYLAB V0.16 — Playtest multijoueur privé (2v2)

Cette version ajoute **des salons privés de 4 joueurs humains** à l'arcade volleyball 3D. Une partie contre des bots reste accessible hors ligne dans les modes 1v1 à 4v4.

## Fonctionnalités testables

- Salon privé avec code à 6 caractères et lien d'invitation
- 2 bleus et 2 rouges, automatiquement assignés dans l'ordre d'arrivée
- Départ automatique dès que les quatre places sont remplies
- Déplacements, accroupissement, plongeon, saut normal/grand saut (double pression), frappe/passe/lob/smash
- Ballon, filet, fautes, trois touches par équipe, service et score **simulés par le serveur**
- Même état de la balle partagé à 20 mises à jour par seconde
- Retour au salon si un participant se déconnecte
- Première à 7 points puis redémarrage de l'entraînement

Les salons vivent en mémoire : leur code expire quand tous les joueurs quittent, ou quand l'hébergement redémarre. Les divisions ne sont pas encore actives, et **les résultats ne sont pas enregistrés**.

## Publication sur Render (offre gratuite)

L'ancienne URL `volleylab-playtest.onrender.com` reste réservée au prototype solo V0.15.
Pour V0.16, utiliser un **nouveau Web Service** Render en plan `free`, région Francfort :

- **Repository** : `https://github.com/iksqua/volleylab`
- **Branch** : `main`
- **Runtime** : Node
- **Build command** : `npm install --omit=dev`
- **Start command** : `npm start`
- **Node** : 22 ou supérieur
- **Root directory** : répertoire racine

Les fichiers `index.html`, `style.css`, `audio.js`, `game.js`, `server.mjs`, `package.json`, `README.md` doivent être à la racine du dépôt. Aucune variable d'environnement ou base de données nécessaire.

Le serveur HTTP et les WebSockets sont **sur le même domaine**. Ne publiez pas uniquement ces fichiers sur un site statique : pour le mode en ligne, il faut exécuter `server.mjs`.

## Tester localement

```
node --check server.mjs
npm start
```

Ouvrir `http://localhost:3000` dans plusieurs navigateurs. Créer un salon, puis ouvrir l'URL d'invitation sur trois autres navigateurs.

## Limites du premier test

- Tests techniques en local réalisés avec 4 connexions WebSocket et vérification visuelle de l'interface ; encore à éprouver en conditions Internet réelles.
- 20 instantanés/seconde, sans interpolation sophistiquée ni reconnexion automatique.
- Hébergement Render gratuit : mise en veille à l'inactivité ; les salons actifs sont perdus si le service redémarre.
- Une seule instance serveur recommandée : salons conservés en RAM.
- Aucune division, compte utilisateur, matchmaking public ou intégration Discord à ce stade.
- Version **expérimentale** à utiliser entre amis avant diffusion publique.
