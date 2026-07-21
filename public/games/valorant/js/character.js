// Modèle de personnage stylisé : capsule (corps) + sphère (tête), une couleur par agent.
// Réutilisé tel quel pour les bots et les autres joueurs (prompts 3 et 6).
// Les agents (couleurs comprises) sont définis dans abilities.js : c'est le fichier
// de données, et il ne dépend pas de Three.
import * as THREE from 'three';

export const BODY_HEIGHT = 1.6;
export const BODY_RADIUS = 0.35;
export const HEAD_RADIUS = 0.22;

// Origine du groupe = les pieds (y = 0), pour poser un modèle directement sur le sol.
export function createCharacterModel(agentColor) {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: agentColor });

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(BODY_RADIUS, BODY_HEIGHT - 2 * BODY_RADIUS, 4, 14),
    mat,
  );
  body.position.y = BODY_HEIGHT / 2;

  const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 18, 12), mat);
  head.position.y = BODY_HEIGHT + HEAD_RADIUS * 0.45; // légèrement enfoncée dans la capsule

  group.add(body, head);
  group.userData.body = body; // hitboxes prêtes pour le prompt 2
  group.userData.head = head;
  return group;
}
