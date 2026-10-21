// Angular ships partially compiled code; loading the compiler lets TestBed link it at runtime.
import '@angular/compiler'
import { getTestBed } from '@angular/core/testing'
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing'
import { beforeEach } from 'vitest'

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting())

// Jasmine and Jest get this reset from Angular's own hooks; vitest without globals does not.
// Resetting before each test (not after) means a failing afterEach can't leak into the next.
beforeEach(() => {
  getTestBed().resetTestingModule()
})
