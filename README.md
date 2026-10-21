# VOLLEYLAB — Playtest V0.15

Prototype de volleyball 3D pour navigateur. Version solo contre des bots : formats 1v1, 2v2, 3v3, 4v4.

## Tester localement

Ouvrir `index.html` dans Chrome/Edge, ou servir ce dossier avec :

```bash
python3 -m http.server 8000
```

Puis ouvrir `http://localhost:8000`.

## Jouer

Les commandes sont personnalisables dans le jeu. Le tutoriel est masqué par défaut et se réactive avec le bouton `?` ou dans les options. Les réglages et préférences sont enregistrés localement quand le navigateur l'autorise.

## Mettre en ligne sur Render

Une configuration `render.yaml` prépare un nouveau site statique gratuit nommé `volleylab-playtest`. Le dépôt GitHub doit contenir ces six fichiers à la racine. Dans Render, créer un **nouveau site statique** lié au dépôt (build `echo ready`, publish directory `.`), ou créer un Blueprint depuis le dépôt pour lire `render.yaml`.

**Ne pas relier cette application à un service AlloCookie existant.**

## Limitation majeure

Ceci n'est **pas encore multijoueur en réseau**. Chaque navigateur lance son propre jeu contre des bots. Les salons privés et les parties entre amis sur plusieurs machines, puis l'intégration Discord, nécessitent un serveur synchronisant joueurs, balle, règles et score.

© VOLLEYLAB — prototype en cours de développement.
