import { type FormEvent, useState } from 'react'

import { errorMessage } from '@/api/client'
import { useCreateCollection, useDeleteCollection, useUpdateCollection } from '@/api/queries'
import type { CollectionOut } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog'
import { Notice } from '@/components/ui/Feedback'
import { Field, Input, Textarea } from '@/components/ui/Form'
import { useToast } from '@/components/ui/Toast'
import { plural } from '@/lib/format'

export const COLLECTION_NAME_MAX = 120
export const COLLECTION_DESCRIPTION_MAX = 500

export interface CollectionFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing; absent when creating. */
  collection?: CollectionOut
  onSaved?: (collection: CollectionOut) => void
}

/** Create or edit a workspace. The form is remounted per open so it never shows stale input. */
export function CollectionFormDialog(props: CollectionFormDialogProps) {
  const { open, onOpenChange, collection } = props
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={collection ? 'Edit workspace' : 'New workspace'}
      description={
        collection ? undefined : 'A workspace holds a set of documents that are searched and compared together.'
      }
    >
      {open ? <CollectionForm key={collection?.id ?? 'new'} {...props} /> : null}
    </Dialog>
  )
}

function CollectionForm({ onOpenChange, collection, onSaved }: CollectionFormDialogProps) {
  const [name, setName] = useState(collection?.name ?? '')
  const [description, setDescription] = useState(collection?.description ?? '')
  const [touched, setTouched] = useState(false)
  const create = useCreateCollection()
  const update = useUpdateCollection()
  const mutation = collection ? update : create
  const toast = useToast()

  const trimmed = name.trim()
  const nameError = touched && trimmed.length === 0 ? 'Enter a name.' : null

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (trimmed.length === 0) return
    const done = (saved: CollectionOut) => {
      toast({ title: collection ? 'Workspace updated' : `Created “${saved.name}”` })
      onOpenChange(false)
      onSaved?.(saved)
    }
    if (collection) {
      update.mutate({ id: collection.id, patch: { name: trimmed, description: description.trim() } }, { onSuccess: done })
    } else {
      create.mutate({ name: trimmed, description: description.trim() }, { onSuccess: done })
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <Field label="Name" error={nameError}>
        {(control) => (
          <Input
            {...control}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={COLLECTION_NAME_MAX}
            autoFocus
            autoComplete="off"
            required
          />
        )}
      </Field>
      <Field label="Description" optional>
        {(control) => (
          <Textarea
            {...control}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={COLLECTION_DESCRIPTION_MAX}
            rows={2}
          />
        )}
      </Field>
      {mutation.isError ? <Notice tone="danger">{errorMessage(mutation.error)}</Notice> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" variant="primary" loading={mutation.isPending}>
          {collection ? 'Save changes' : 'Create workspace'}
        </Button>
      </div>
    </form>
  )
}

export interface DeleteCollectionDialogProps {
  collection: CollectionOut | null
  onOpenChange: (open: boolean) => void
  onDeleted?: (collection: CollectionOut) => void
}

export function DeleteCollectionDialog({ collection, onOpenChange, onDeleted }: DeleteCollectionDialogProps) {
  const remove = useDeleteCollection()
  const toast = useToast()
  if (!collection) return null
  const contents =
    collection.document_count === 0
      ? 'It contains no documents.'
      : `This permanently removes ${plural(collection.document_count, 'document')}, the uploaded files, their extracted text and the search index.`
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) remove.reset()
        onOpenChange(open)
      }}
      title={`Delete “${collection.name}”?`}
      description={`${contents} This cannot be undone.`}
      confirmLabel="Delete workspace"
      destructive
      pending={remove.isPending}
      error={remove.isError ? errorMessage(remove.error) : null}
      onConfirm={() =>
        remove.mutate(collection.id, {
          onSuccess: () => {
            toast({ title: `Deleted “${collection.name}”` })
            onOpenChange(false)
            onDeleted?.(collection)
          },
        })
      }
    />
  )
}
