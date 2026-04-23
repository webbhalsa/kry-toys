export type TerminalPaneNode = {
  type: 'terminal'
  id: string
  number: number
  label?: string
}

export type SplitPaneNode = {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: [PaneNode, PaneNode]
}

export type PaneNode = TerminalPaneNode | SplitPaneNode

export type ActivityEntry = {
  activity: string
  cwd?: string
  branch?: string | null
  ts: number
}

export type PaneState = {
  cwd: string
  hadClaude: boolean
  claudeSessionId?: string
  claudeSessionName?: string
  activityLog?: ActivityEntry[]
}

export type Tab = {
  id: string
  name: string
  rootPane: PaneNode
  nextTerminalNumber: number
  paneStates: Record<string, PaneState>
}

export type WorkspaceSession = {
  name: string
  rootPane: PaneNode
  accentColor?: string
  paneStates?: Record<string, PaneState>
}
