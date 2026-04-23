import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { PaneNode } from '../types'
import { TerminalPane } from './TerminalPane'
import { useWorkspaceStore } from '../store/workspaceStore'

interface Props {
  node: PaneNode
}

export function SplitContainer({ node }: Props) {
  const { splitPane, closePane, renamePane } = useWorkspaceStore()

  if (node.type === 'terminal') {
    return (
      <TerminalPane
        paneId={node.id}
        number={node.number ?? 1}
        label={node.label}
        onSplit={(direction) => splitPane(node.id, direction)}
        onClose={() => closePane(node.id)}
        onRename={(label) => renamePane(node.id, label)}
      />
    )
  }

  return (
    <div style={{ height: '100%', overflow: 'hidden' }}>
      <Allotment key={node.id} vertical={node.direction === 'vertical'}>
        <Allotment.Pane key={node.children[0].id}>
          <SplitContainer node={node.children[0]} />
        </Allotment.Pane>
        <Allotment.Pane key={node.children[1].id}>
          <SplitContainer node={node.children[1]} />
        </Allotment.Pane>
      </Allotment>
    </div>
  )
}
