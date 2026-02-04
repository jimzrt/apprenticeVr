import React, { useState, useEffect } from 'react'
import { GameInfo } from '@shared/types'
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  Button,
  DialogContent,
  tokens,
  shorthands,
  makeStyles,
  Text,
  Image,
  Badge,
  Divider,
  Spinner,
  ProgressBar
} from '@fluentui/react-components'
import {
  ArrowClockwiseRegular,
  DismissRegular,
  DocumentDataRegular,
  CalendarClockRegular,
  ArrowDownloadRegular as DownloadIcon,
  TagRegular,
  DeleteRegular,
  ArrowSyncRegular,
  ArrowUpRegular,
  InfoRegular,
  CheckmarkCircleRegular,
  VideoRegular,
  BroomRegular as UninstallIcon
} from '@fluentui/react-icons'
import placeholderImage from '../assets/images/game-placeholder.png'
import youtubeLogo from '../assets/images/youtube-logo.svg'
import YouTube from 'react-youtube'
import { useGames } from '@renderer/hooks/useGames'

const useStyles = makeStyles({
  dialogContentLayout: {
    display: 'grid',
    gridTemplateColumns: '150px 1fr',
    gap: tokens.spacingHorizontalM,
    alignItems: 'start'
  },
  detailsColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM
  },
  infoSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS
  },
  badgesAndInfoContainer: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'center',
    marginTop: tokens.spacingVerticalS,
    flexWrap: 'wrap'
  },
  badgeGroup: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center'
  },
  inlineInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS
  },
  detailList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM
  },
  noteSection: {
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM
  },
  noteTitle: {
    marginBottom: tokens.spacingVerticalS,
    display: 'block'
  },
  noteContent: {
    whiteSpace: 'pre-wrap',
    maxHeight: '150px',
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium
  },
  actionsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS
  },
  deleteConfirmText: {
    ...shorthands.padding(tokens.spacingVerticalM, 0)
  },
  installingIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS
  },
  dialogHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%'
  },
  dismissButton: {
    position: 'absolute',
    top: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalXS),
    minWidth: 'unset'
  },
  trailerSection: {
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM
  },
  youtubeContainer: {
    position: 'relative',
    width: '100%',
    paddingTop: '56.25%', // 16:9 aspect ratio
    marginTop: tokens.spacingVerticalM
  },
  youtubeFallback: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    display: 'grid',
    placeItems: 'center',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    textAlign: 'center'
  },
  youtubeFallbackContent: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM
  },
  youtubeFallbackThumb: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    position: 'absolute',
    inset: 0,
    filter: 'brightness(0.45)'
  },
  youtubeFallbackLogo: {
    width: '120px',
    height: 'auto',
    marginBottom: tokens.spacingVerticalS
  },
  youtubeFallbackOverlay: {
    position: 'relative',
    zIndex: 1
  },
  youtubePlayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%'
  },
  trailerTitle: {
    marginBottom: tokens.spacingVerticalS,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS
  },
  progressSection: {
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM
  }
})

interface GameDetailsDialogProps {
  game: GameInfo | null
  open: boolean
  onClose: () => void
  downloadStatusMap: Map<string, { status: string; progress: number }>
  onInstall: (game: GameInfo) => void
  onUninstall: (game: GameInfo) => Promise<void>
  onReinstall: (game: GameInfo) => Promise<void>
  onUpdate: (game: GameInfo) => Promise<void>
  onRetry: (game: GameInfo) => void
  onCancelDownload: (game: GameInfo) => void
  onDeleteDownloaded: (game: GameInfo) => void
  onInstallFromCompleted: (game: GameInfo) => void
  getNote: (releaseName: string) => Promise<string | null>
  isConnected: boolean
  isBusy: boolean
}

const GameDetailsDialog: React.FC<GameDetailsDialogProps> = ({
  game,
  open,
  onClose,
  downloadStatusMap,
  onInstall,
  onUninstall,
  onReinstall,
  onUpdate,
  onRetry,
  onCancelDownload,
  onDeleteDownloaded,
  onInstallFromCompleted,
  getNote,
  isConnected,
  isBusy
}) => {
  const styles = useStyles()
  const { getTrailerVideoId: getTrailerVideoIdFromContext } = useGames()
  const [currentGameNote, setCurrentGameNote] = useState<string | null>(null)
  const [loadingNote, setLoadingNote] = useState<boolean>(false)
  const [videoId, setVideoId] = useState<string | null>(null)
  const [loadingVideo, setLoadingVideo] = useState<boolean>(false)
  const [videoError, setVideoError] = useState<boolean>(false)

  // Fetch note when dialog opens or game changes
  useEffect(() => {
    let isMounted = true

    if (open && game && game.releaseName) {
      const fetchNote = async (): Promise<void> => {
        setLoadingNote(true)
        setCurrentGameNote(null)
        try {
          const note = await getNote(game.releaseName)
          if (isMounted) {
            setCurrentGameNote(note)
          }
        } catch (err) {
          console.error(`Error fetching note for ${game.releaseName}:`, err)
          if (isMounted) {
            setCurrentGameNote('Error loading note.')
          }
        } finally {
          if (isMounted) {
            setLoadingNote(false)
          }
        }
      }
      fetchNote()
    }

    return () => {
      isMounted = false
    }
  }, [open, game, getNote])

  useEffect(() => {
    let isMounted = true

    const getTrailerVideoId = async (): Promise<void> => {
      if (!game?.name) return

      setLoadingVideo(true)
      setVideoId(null)
      setVideoError(false)

      try {
        const videoId = await getTrailerVideoIdFromContext(game.name)

        if (isMounted && videoId) {
          setVideoId(videoId)
        }
      } catch (error) {
        console.error('Error searching for game trailer:', error)
      } finally {
        if (isMounted) {
          setLoadingVideo(false)
        }
      }
    }

    if (open && game?.name) {
      getTrailerVideoId()
    }

    return () => {
      isMounted = false
    }
  }, [open, game, getTrailerVideoIdFromContext])

  const getYouTubeOrigin = (): string | undefined => {
    if (typeof window === 'undefined') return undefined
    const origin = window.location.origin
    if (origin === 'null' || origin.startsWith('file:')) {
      return 'http://localhost'
    }
    return origin
  }

  // Helper function to render action buttons based on game state
  const renderActionButtons = (currentGame: GameInfo): React.ReactNode => {
    const status = downloadStatusMap.get(currentGame.releaseName || '')?.status
    const canCancel = status === 'Downloading' || status === 'Extracting' || status === 'Queued'
    const isDownloaded = status === 'Completed'
    const isInstalled = currentGame.isInstalled
    const hasUpdate = currentGame.hasUpdate
    const isInstallError = status === 'InstallError'
    const isErrorOrCancelled = status === 'Error' || status === 'Cancelled'
    const isInstalling = status === 'Installing'

    if (isInstalling) {
      return (
        <div className={styles.installingIndicator}>
          <Spinner size="small" />
          <Text>Installing...</Text>
        </div>
      )
    }

    if (canCancel) {
      return (
        <Button
          appearance="danger"
          icon={<DismissRegular />}
          onClick={() => onCancelDownload(currentGame)}
          disabled={isBusy}
        >
          Cancel Download
        </Button>
      )
    }

    if (isInstallError || isErrorOrCancelled) {
      return (
        <>
          <Button
            appearance="primary"
            icon={<ArrowClockwiseRegular />}
            onClick={() => onRetry(currentGame)}
            disabled={isBusy}
          >
            Retry
          </Button>
          <Button
            appearance="danger"
            icon={<DeleteRegular />}
            onClick={() => onDeleteDownloaded(currentGame)}
            disabled={isBusy}
          >
            Delete Downloaded Files
          </Button>
        </>
      )
    }

    if (isInstalled) {
      if (hasUpdate) {
        return (
          <>
            <Button
              appearance="primary"
              icon={<ArrowUpRegular />}
              onClick={() => onUpdate(currentGame)}
              disabled={!isConnected || isBusy}
            >
              Update
            </Button>
            <Button
              appearance="danger"
              icon={<UninstallIcon />}
              onClick={() => onUninstall(currentGame)}
              disabled={!isConnected || isBusy}
            >
              Uninstall
            </Button>
          </>
        )
      } else {
        return (
          <>
            <Button
              appearance="secondary"
              icon={<ArrowSyncRegular />}
              onClick={() => onReinstall(currentGame)}
              disabled={!isConnected || isBusy}
            >
              Reinstall
            </Button>
            <Button
              appearance="danger"
              icon={<UninstallIcon />}
              onClick={() => onUninstall(currentGame)}
              disabled={!isConnected || isBusy}
            >
              Uninstall
            </Button>
          </>
        )
      }
    }

    if (isDownloaded) {
      return (
        <>
          <Button
            appearance="primary"
            icon={<CheckmarkCircleRegular />}
            onClick={() => onInstallFromCompleted(currentGame)}
            disabled={!isConnected || isBusy}
          >
            Install
          </Button>
          <Button
            appearance="danger"
            icon={<DeleteRegular />}
            onClick={() => onDeleteDownloaded(currentGame)}
            disabled={isBusy}
          >
            Delete Downloaded Files
          </Button>
        </>
      )
    }

    return (
      <Button
        appearance="primary"
        icon={<DownloadIcon />}
        onClick={() => onInstall(currentGame)}
        disabled={isBusy}
      >
        {isConnected ? 'Install' : 'Download'}
      </Button>
    )
  }

  const handleClose = (): void => {
    onClose()
  }

  if (!game) return null

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(_e, data) => !data.open && handleClose()}
        modalType="modal"
      >
        <DialogSurface mountNode={document.getElementById('portal')}>
          <DialogBody>
            <div className={styles.dialogHeader}>
              <DialogTitle>{game?.name}</DialogTitle>
              <Button
                appearance="subtle"
                icon={<DismissRegular />}
                onClick={handleClose}
                className={styles.dismissButton}
                aria-label="Close"
              />
            </div>
            <DialogContent>
              <div className={styles.dialogContentLayout}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%'
                  }}
                >
                  <Image
                    src={game.thumbnailPath ? `file://${game.thumbnailPath}` : placeholderImage}
                    alt={`${game.name} thumbnail`}
                    shape="rounded"
                    width={150}
                    height={150}
                    fit="cover"
                    style={{
                      height: '150px',
                      width: '150px'
                    }}
                  />
                </div>
                <div className={styles.detailsColumn}>
                  <div className={styles.infoSection}>
                    <Text size={600} weight="semibold">
                      {game.name}
                    </Text>
                    <Text
                      size={300}
                      weight="regular"
                      style={{ color: tokens.colorNeutralForeground2 }}
                    >
                      {game.packageName}
                    </Text>
                    <div className={styles.badgesAndInfoContainer}>
                      <div className={styles.badgeGroup}>
                        <Badge
                          shape="rounded"
                          color={(() => {
                            const status = downloadStatusMap.get(game.releaseName || '')?.status
                            if (game.isInstalled) return 'success'
                            if (status === 'Completed') return 'brand'
                            if (status === 'InstallError') return 'danger'
                            if (status === 'Installing') return 'brand'
                            return 'informative'
                          })()}
                          appearance="filled"
                        >
                          {(() => {
                            const status = downloadStatusMap.get(game.releaseName || '')?.status
                            if (game.isInstalled) return 'Installed'
                            if (status === 'Completed') return 'Downloaded'
                            if (status === 'InstallError') return 'Install Error'
                            if (status === 'Installing') return 'Installing'
                            return 'Not Installed'
                          })()}
                        </Badge>
                        {game.hasUpdate && (
                          <Badge shape="rounded" color="brand" appearance="filled">
                            Update Available
                          </Badge>
                        )}
                      </div>
                      <div className={styles.inlineInfo}>
                        <DocumentDataRegular fontSize={16} />
                        <Text size={300}>{game.size || '-'}</Text>
                      </div>
                      <div className={styles.inlineInfo}>
                        <DownloadIcon fontSize={16} />
                        <Text size={300}>{game.downloads?.toLocaleString() || '-'}</Text>
                      </div>
                      <div className={styles.inlineInfo}>
                        <InfoRegular fontSize={16} />
                        <Text size={300}>
                          {game.version ? `v${game.version}` : '-'}
                          <span
                            style={{
                              color: tokens.colorNeutralForeground3,
                              fontSize: 12,
                              fontWeight: 'bold'
                            }}
                          >
                            {game.isInstalled &&
                              game.deviceVersionCode &&
                              ` (Device: v${game.deviceVersionCode})`}
                          </span>
                        </Text>
                      </div>
                    </div>
                  </div>
                  <Divider />
                  <div className={styles.detailList}>
                    <div className={styles.inlineInfo}>
                      <TagRegular fontSize={16} />
                      <Text>{game.releaseName || '-'}</Text>
                    </div>
                    <div className={styles.inlineInfo}>
                      <CalendarClockRegular fontSize={16} />
                      <Text>{game.lastUpdated || '-'}</Text>
                    </div>
                  </div>
                </div>
              </div>
              <Divider style={{ marginTop: tokens.spacingVerticalS }} />
              <div className={styles.noteSection}>
                <Text weight="semibold" className={styles.noteTitle}>
                  Note:
                </Text>
                {loadingNote ? (
                  <Spinner size="tiny" label="Loading note..." />
                ) : currentGameNote ? (
                  <div className={styles.noteContent}>{currentGameNote}</div>
                ) : (
                  <Text>No note available.</Text>
                )}
              </div>

              <div className={styles.trailerSection}>
                <div className={styles.trailerTitle}>
                  <VideoRegular fontSize={16} />
                  <Text weight="semibold">Trailer:</Text>
                </div>
                {loadingVideo ? (
                  <Spinner size="tiny" label="Searching for trailer..." />
                ) : videoError && videoId ? (
                  <div className={styles.youtubeContainer}>
                    <div className={styles.youtubeFallback}>
                      <img
                        className={styles.youtubeFallbackThumb}
                        src={`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`}
                        alt="Trailer thumbnail"
                      />
                      <div className={styles.youtubeFallbackOverlay}>
                        <div className={styles.youtubeFallbackContent}>
                          <img
                            className={styles.youtubeFallbackLogo}
                            src={youtubeLogo}
                            alt="YouTube"
                          />
                          <Text weight="semibold">Trailer can’t play in-app</Text>
                          <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                            Some videos block embeds. Open it on YouTube instead.
                          </Text>
                          <Button
                            appearance="primary"
                            onClick={() =>
                              window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank')
                            }
                          >
                            Open on YouTube
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : videoId ? (
                  <div className={styles.youtubeContainer}>
                    <YouTube
                      videoId={videoId}
                      className={styles.youtubePlayer}
                      opts={{
                        width: '100%',
                        height: '100%',
                        host: 'https://www.youtube.com',
                        playerVars: {
                          autoplay: 0,
                          origin: getYouTubeOrigin()
                        }
                      }}
                      onError={() => {
                        setVideoError(true)
                      }}
                    />
                  </div>
                ) : (
                  <Text>No trailer available.</Text>
                )}
              </div>

              {/* Download Progress Section */}
              {game.releaseName && downloadStatusMap.get(game.releaseName) && (
                <div className={styles.progressSection}>
                  {(() => {
                    const status = downloadStatusMap.get(game.releaseName || '')?.status
                    const progress = downloadStatusMap.get(game.releaseName || '')?.progress || 0
                    const isDownloading = status === 'Downloading'
                    const isExtracting = status === 'Extracting'
                    const isInstalling = status === 'Installing'

                    if (isDownloading || isExtracting || isInstalling) {
                      return (
                        <>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: tokens.spacingHorizontalS,
                              marginBottom: tokens.spacingVerticalS
                            }}
                          >
                            <Spinner size="tiny" />
                            <Text weight="semibold">
                              {status}... {progress}%
                            </Text>
                          </div>
                          <ProgressBar
                            value={progress}
                            max={100}
                            shape="rounded"
                            thickness="medium"
                            aria-label={`${status} progress`}
                          />
                        </>
                      )
                    }
                    return null
                  })()}
                </div>
              )}

              <div className={styles.actionsList}>{renderActionButtons(game)}</div>
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  )
}

export default GameDetailsDialog
