# claude-prime

Mon premier projet claude-prime. Il contient une page web statique, prête à être publiée avec GitHub Pages.

## Contenu

- `index.html` : la page d'accueil.
- `style.css` : les styles, avec un thème clair et un thème sombre.
- `.nojekyll` : demande à GitHub Pages de servir les fichiers tels quels.

## Publier avec GitHub Pages

1. Ouvrez le dépôt sur GitHub, puis `Settings`, puis `Pages`.
2. Dans `Build and deployment`, choisissez `Deploy from a branch`.
3. Sélectionnez la branche `main` et le dossier `/ (root)`, puis cliquez sur `Save`.
4. Attendez environ une minute. L'adresse du site s'affiche en haut de la page `Pages`.

L'adresse sera de la forme `https://<compte>.github.io/claude-prime/`.

Un dépôt privé exige un plan GitHub qui autorise Pages sur les dépôts privés. Sinon, passez le dépôt en public dans `Settings`, section `Danger Zone`.

## Tester en local

Ouvrez `index.html` dans votre navigateur. Ou lancez un petit serveur :

```sh
python3 -m http.server 8000
```

Puis allez sur http://localhost:8000.

## Modifier la page

Changez le texte dans `index.html` et les couleurs dans les variables en haut de `style.css`. Publiez vos changements avec `git push` sur `main`. GitHub Pages se met à jour seul.
