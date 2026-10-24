/**
 * Where things live in the bucket. Everything for a user sits under users/<id>/, and everything for
 * a project under users/<id>/projects/<id>/, so deleting a project or an account is deleting a prefix.
 */
export const userPrefix = (userId: string) => `users/${userId}/`
export const projectPrefix = (userId: string, projectId: string) =>
  `users/${userId}/projects/${projectId}/`

export const rawKey = (userId: string, projectId: string, assetId: string, ext: string) =>
  `${projectPrefix(userId, projectId)}raw/${assetId}${ext}`
export const proxyKey = (userId: string, projectId: string) =>
  `${projectPrefix(userId, projectId)}proxy/proxy.mp4`
export const sceneClipKey = (userId: string, projectId: string, idx: number) =>
  `${projectPrefix(userId, projectId)}scenes/scene-${String(idx).padStart(4, '0')}.mp4`
export const thumbnailKey = (userId: string, projectId: string, idx: number) =>
  `${projectPrefix(userId, projectId)}thumbs/scene-${String(idx).padStart(4, '0')}.jpg`
export const exportKey = (userId: string, projectId: string, name: string) =>
  `${projectPrefix(userId, projectId)}exports/${name}`
export const audioKey = (userId: string, projectId: string) =>
  `${projectPrefix(userId, projectId)}audio/audio.wav`

/** Style Reels and their thumbnails: users/<id>/style/, so disconnecting is deleting one prefix. */
export const stylePrefix = (userId: string) => `users/${userId}/style/`
export const styleReelKey = (userId: string, assetId: string, ext: string) =>
  `${stylePrefix(userId)}reels/${assetId}${ext}`
export const styleThumbKey = (userId: string, reelId: string) =>
  `${stylePrefix(userId)}thumbs/${reelId}.jpg`
