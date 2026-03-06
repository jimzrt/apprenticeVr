import React, { useMemo, useState } from 'react'
import { useDownload } from '../hooks/useDownload'
import { useAdb } from '../hooks/useAdb'
import { DownloadItem } from '@shared/types'
import {
  makeStyles,
  tokens,
  Title2,
  Text,
  Button,
  ProgressBar,
  Image,
  Badge,
  Dropdown,
  Option
} from '@fluentui/react-components'
import {
  DeleteRegular,
  DismissRegular as CloseIcon,
  ArrowCounterclockwiseRegular as RetryIcon,
  ArrowDownloadRegular as DownloadInstallIcon,
  BroomRegular as UninstallIcon
} from '@fluentui/react-icons'
import { formatDistanceToNow } from 'date-fns'
import placeholderImage from '../assets/images/game-placeholder.png'
import { useGames } from '@renderer/hooks/useGames'
import { useGameDialog } from '@renderer/hooks/useGameDialog'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    padding: tokens.spacingHorizontalXXL,
    gap: tokens.spacingVerticalL
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM
  },
  sortControls: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS
  },
  sortDropdown: {
    minWidth: '160px'
  },
  itemRow: {
    display: 'grid',
    gridTemplateColumns: '60px 1fr auto auto', // Thumbnail, Info, Progress/Status, Actions
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`
  },
  thumbnail: {
    width: '60px',
    height: '60px',
    objectFit: 'cover'
  },
  gameInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    cursor: 'pointer'
  },
  gameNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS
  },
  installedBadge: {
    fontSize: tokens.fontSizeBase100
  },
  progressStatus: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: tokens.spacingVerticalXS,
    width: '150px' // Fixed width for progress/status text
  },
  progressBar: {
    width: '100%'
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    marginTop: tokens.spacingVerticalXS,
    alignItems: 'flex-end'
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200
  },
  statusText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2
  }
})

interface DownloadsViewProps {
  onClose: () => void
}

const DownloadsView: React.FC<DownloadsViewProps> = ({ onClose }) => {
  const styles = useStyles()
  const { queue, isLoading, error, removeFromQueue, cancelDownload, retryDownload } = useDownload()
  const { selectedDevice, isConnected, loadPackages } = useAdb()
  const { games } = useGames()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_, setDialogGame] = useGameDialog()
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'size'>('date')

  const formatAddedTime = (timestamp: number): string => {
    try {
      return formatDistanceToNow(new Date(timestamp), { addSuffix: true })
    } catch (e: unknown) {
      console.error('Error formatting date:', e)
      return 'Invalid date'
    }
  }

  const gameSizeByRelease = useMemo(() => {
    const map = new Map<string, string>()
    for (const game of games) {
      if (game.releaseName && game.size) {
        map.set(game.releaseName, game.size)
      }
      if (game.packageName && game.size) {
        map.set(game.packageName, game.size)
      }
    }
    return map
  }, [games])

  const resolveItemSize = (item: DownloadItem): string | undefined => {
    if (item.size && item.size.trim().length > 0) {
      return item.size
    }
    return gameSizeByRelease.get(item.releaseName) || gameSizeByRelease.get(item.packageName)
  }

  const formatSize = (size?: string): string => {
    if (!size || size.trim().length === 0) return 'Unknown size'
    return size
  }

  const parseSizeToBytes = (size?: string): number => {
    if (!size) return 0
    const match = size.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i)
    if (!match) return 0
    const value = Number(match[1])
    if (Number.isNaN(value)) return 0
    const unit = match[2].toUpperCase()
    const multiplier =
      unit === 'KB'
        ? 1024
        : unit === 'MB'
          ? 1024 ** 2
          : unit === 'GB'
            ? 1024 ** 3
            : unit === 'TB'
              ? 1024 ** 4
              : 1
    return value * multiplier
  }

  const sortedQueue = useMemo(() => {
    const copy = [...queue]
    if (sortBy === 'name') {
      copy.sort((a, b) => a.gameName.localeCompare(b.gameName))
    } else if (sortBy === 'size') {
      copy.sort(
        (a, b) =>
          parseSizeToBytes(resolveItemSize(b)) - parseSizeToBytes(resolveItemSize(a))
      )
    } else {
      copy.sort((a, b) => b.addedDate - a.addedDate)
    }
    return copy
  }, [queue, sortBy, gameSizeByRelease])

  const handleInstallFromCompleted = (releaseName: string): void => {
    if (!releaseName || !selectedDevice) {
      console.error('Missing releaseName or selectedDevice for install from completed action')
      window.alert('Cannot start installation: Missing required information.')
      return
    }
    console.log(`Requesting install from completed for ${releaseName} on ${selectedDevice}`)
    window.api.downloads.installFromCompleted(releaseName, selectedDevice).catch((err) => {
      console.error('Error triggering install from completed:', err)
      window.alert('Failed to start installation. Please check the main process logs.')
    })
  }

  const handleUninstall = async (item: DownloadItem): Promise<void> => {
    const game = games.find((g) => g.releaseName === item.releaseName)
    if (!game || !game.packageName || !selectedDevice) {
      console.error('Cannot uninstall: Missing game data, package name, or selected device')
      window.alert('Cannot uninstall: Missing required information.')
      return
    }

    const confirmUninstall = window.confirm(
      `Are you sure you want to uninstall ${game.name} (${game.packageName})? This will remove the app and its data from the device.`
    )

    if (confirmUninstall) {
      console.log(`Uninstalling ${game.packageName} from ${selectedDevice}`)
      try {
        const success = await window.api.adb.uninstallPackage(selectedDevice, game.packageName)
        if (success) {
          console.log('Uninstall successful')
          await loadPackages()
        } else {
          console.error('Uninstall failed')
          window.alert('Failed to uninstall the game.')
        }
      } catch (err) {
        console.error('Error during uninstall:', err)
        window.alert('An error occurred during uninstallation.')
      }
    }
  }

  const isInstalled = (releaseName: string): boolean => {
    return games.some((game) => game.releaseName === releaseName && game.isInstalled)
  }

  if (isLoading) {
    return <div className={styles.root}>Loading download queue...</div>
  }

  if (error) {
    return (
      <div className={styles.root}>
        <Title2>Downloads</Title2>
        <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
          Error loading queue: {error}
        </Text>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      {queue.length === 0 ? (
        <Text>Download queue is empty.</Text>
      ) : (
        <div>
          <div className={styles.headerRow}>
            <Title2>Downloads</Title2>
            <div className={styles.sortControls}>
              <Text size={200}>Sort by</Text>
              <Dropdown
                className={styles.sortDropdown}
                value={
                  sortBy === 'name' ? 'Name' : sortBy === 'size' ? 'Size' : 'Date Added'
                }
                selectedOptions={[sortBy]}
                onOptionSelect={(_, data) => {
                  if (data.optionValue) {
                    setSortBy(data.optionValue as 'date' | 'name' | 'size')
                  }
                }}
                placeholder="Sort by..."
              >
                <Option value="date" text="Date Added">
                  Date Added
                </Option>
                <Option value="name" text="Name">
                  Name
                </Option>
                <Option value="size" text="Size">
                  Size
                </Option>
              </Dropdown>
            </div>
          </div>
          {sortedQueue.map((item) => (
              <div key={item.releaseName} className={styles.itemRow}>
                {/* Thumbnail */}
                <Image
                  src={item.thumbnailPath ? `file://${item.thumbnailPath}` : placeholderImage}
                  alt={`${item.gameName} thumbnail`}
                  className={styles.thumbnail}
                  shape="rounded"
                  fit="cover"
                />
                {/* Game Info */}
                <div
                  className={styles.gameInfo}
                  onClick={() => {
                    let gameToOpen = games.find((g) => g.releaseName === item.releaseName)
                    if (!gameToOpen) {
                      console.log('Game not found by release name, trying by package name')
                      gameToOpen = games.find((g) => g.packageName === item.packageName)
                    }
                    if (gameToOpen) {
                      setDialogGame(gameToOpen)
                    }
                    onClose()
                  }}
                >
                  <div className={styles.gameNameRow}>
                    <Text weight="semibold">{item.gameName}</Text>
                    {isInstalled(item.releaseName) && (
                      <Badge
                        appearance="filled"
                        color="success"
                        size="small"
                        className={styles.installedBadge}
                      >
                        Installed
                      </Badge>
                    )}
                  </div>
                  <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                    {item.releaseName}
                  </Text>
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                    Added: {formatAddedTime(item.addedDate)} · Size:{' '}
                    {formatSize(resolveItemSize(item))}
                  </Text>
                </div>
                {/* Progress / Status */}
                <div className={styles.progressStatus}>
                  {item.status === 'Downloading' && (
                    <>
                      <ProgressBar value={item.progress / 100} className={styles.progressBar} />
                      <Text className={styles.statusText}>{item.progress}%</Text>
                      {item.speed && (
                        <Text size={200} className={styles.statusText}>
                          Speed: {item.speed}
                        </Text>
                      )}
                      {item.eta &&
                        item.eta !== '-' && ( // Don't show ETA if it's just '-'
                          <Text size={200} className={styles.statusText}>
                            ETA: {item.eta}
                          </Text>
                        )}
                    </>
                  )}
                  {/* Added Extraction Progress Display */}
                  {item.status === 'Extracting' && (
                    <>
                      <ProgressBar
                        value={(item.extractProgress || 0) / 100}
                        className={styles.progressBar}
                      />
                      <Text className={styles.statusText}>
                        Extracting... {item.extractProgress || 0}%
                      </Text>
                    </>
                  )}
                  {item.status === 'Installing' && (
                    <Text className={styles.statusText}>Installing...</Text>
                  )}
                  {item.status === 'Queued' && <Text className={styles.statusText}>Queued</Text>}
                  {item.status === 'Completed' && (
                    <Text style={{ color: tokens.colorPaletteGreenForeground1 }}>Completed</Text>
                  )}
                  {item.status === 'Cancelled' && (
                    <Text className={styles.statusText}>Cancelled</Text>
                  )}
                  {item.status === 'Error' && (
                    <>
                      <Text className={styles.errorText}>Error</Text>
                      {item.error && (
                        <Text size={200} className={styles.errorText} title={item.error}>
                          {item.error.substring(0, 30)}...
                        </Text>
                      )}
                    </>
                  )}
                  {item.status === 'InstallError' && (
                    <>
                      <Text className={styles.errorText}>Install Error</Text>
                      {item.error && (
                        <Text size={200} className={styles.errorText} title={item.error}>
                          {item.error.substring(0, 30)}...
                        </Text>
                      )}
                    </>
                  )}

                  {/* Install/Uninstall Buttons */}
                  {item.status === 'Completed' && !isInstalled(item.releaseName) && (
                    <Button
                      icon={<DownloadInstallIcon />}
                      aria-label="Install game"
                      size="small"
                      appearance="primary"
                      onClick={() => handleInstallFromCompleted(item.releaseName)}
                      disabled={!isConnected || !selectedDevice}
                      title={
                        !isConnected || !selectedDevice ? 'Connect a device to install' : 'Install'
                      }
                    >
                      Install
                    </Button>
                  )}

                  {item.status === 'Completed' && isInstalled(item.releaseName) && (
                    <Button
                      icon={<UninstallIcon />}
                      aria-label="Uninstall game"
                      size="small"
                      appearance="outline"
                      onClick={() => handleUninstall(item)}
                      disabled={!isConnected || !selectedDevice}
                      title={
                        !isConnected || !selectedDevice
                          ? 'Connect a device to uninstall'
                          : 'Uninstall'
                      }
                    >
                      Uninstall
                    </Button>
                  )}
                </div>
                {/* Actions */}
                <div className={styles.actions}>
                  {/* Cancel Button */}
                  {(item.status === 'Queued' ||
                    item.status === 'Downloading' ||
                    item.status === 'Extracting' ||
                    item.status === 'Installing') && (
                    <Button
                      icon={<CloseIcon />}
                      aria-label="Cancel"
                      size="small"
                      appearance="subtle"
                      onClick={() => cancelDownload(item.releaseName)}
                      title="Cancel"
                    />
                  )}

                  {/* Retry Button */}
                  {(item.status === 'Cancelled' ||
                    item.status === 'Error' ||
                    item.status === 'InstallError') && (
                    <Button
                      icon={<RetryIcon />}
                      aria-label="Retry download"
                      size="small"
                      appearance="subtle"
                      onClick={() => retryDownload(item.releaseName)}
                      title="Retry"
                    />
                  )}

                  {/* Remove Button (appears when not actively downloading/extracting/installing) */}
                  {(item.status === 'Completed' ||
                    item.status === 'Cancelled' ||
                    item.status === 'Error' ||
                    item.status === 'InstallError' ||
                    item.status === 'Queued') && (
                    <Button
                      icon={<DeleteRegular />}
                      aria-label="Remove from list and delete files"
                      size="small"
                      appearance="subtle"
                      onClick={async () => await removeFromQueue(item.releaseName)}
                      title="Remove from list and delete files"
                    />
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

export default DownloadsView
