// Angular ships partially compiled code; loading the compiler lets TestBed link it at runtime.
import '@angular/compiler'
import { getTestBed } from '@angular/core/testing'
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing'
import { beforeEach } from 'vitest'

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting())

// Vitest without globals doesn't get Angular's own reset hook. Resetting before each test (not
// after) means a failing afterEach can't leak into the next.
beforeEach(() => {
  getTestBed().resetTestingModule()
})
