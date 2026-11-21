import { Component } from '@angular/core'
import {
  injectJsonApiReads,
  injectJsonApiWrites,
  JsonApiErrorPipe,
} from '@haddowg/json-api-angular/query'
import { injectMutation, injectQuery } from '@tanstack/angular-query'

/**
 * The caller's account, a singleton the server serves at `/me` with no id. The read takes no id,
 * and the rename passes the id the read returned, since the request body must carry it. A
 * successful write patches the account in the cache, so the header updates without a refetch.
 */
@Component({
  selector: 'app-account',
  imports: [JsonApiErrorPipe],
  template: `
    @if (account.data(); as me) {
      <form
        (submit)="$event.preventDefault(); rename.mutate({ id: me.id, displayName: name.value })"
      >
        <span>Signed in as {{ me.displayName }}</span>
        <input #name [value]="me.displayName" aria-label="Display name" />
        <button type="submit" [disabled]="rename.isPending()">Rename</button>
      </form>
      @if (rename.error() | jsonApiError; as error) {
        <p class="error">{{ error.byPath()['displayName']?.[0]?.detail }}</p>
      }
    }
  `,
})
export class Account {
  private readonly reads = injectJsonApiReads()
  private readonly writes = injectJsonApiWrites()

  protected readonly account = injectQuery(() => this.reads.accounts.get())
  protected readonly rename = injectMutation(() => this.writes.accounts.update())
}
