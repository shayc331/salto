/*
 * Copyright 2025 Salto Labs Ltd.
 * Licensed under the Salto Terms of Use (the "License");
 * You may not use this file except in compliance with the License.  You may obtain a copy of the License at https://www.salto.io/terms-of-use
 *
 * CERTAIN THIRD PARTY SOFTWARE MAY BE CONTAINED IN PORTIONS OF THE SOFTWARE. See NOTICE FILE AT https://github.com/salto-io/salto/blob/main/NOTICES
 */
import {
  BuiltinTypes,
  CORE_ANNOTATIONS,
  Element,
  ElemID,
  Field,
  InstanceElement,
  isInstanceElement,
  isReferenceExpression,
  ListType,
  ObjectType,
  ReferenceExpression,
} from '@salto-io/adapter-api'
import _ from 'lodash'
import { collections } from '@salto-io/lowerdash'
import {
  getParent,
  getParentOrUndefined,
  isResolvedReferenceExpression,
  walkOnValue,
  WALK_NEXT_STEP,
} from '@salto-io/adapter-utils'
import { logger } from '@salto-io/logging'
import { FilterCreator } from '../filter'
import { AUTOMATION_TYPE, BOARD_TYPE_NAME, FIELD_TYPE, PROJECT_TYPE } from '../constants'
import { FIELD_CONTEXT_TYPE_NAME } from './fields/constants'
import { addOrUpdate } from '../utils'

const log = logger(module)
const { makeArray } = collections.array

export const PROJECT_SCOPE_FIELD_NAME = 'projectsScope'

type BoardWithProjectId = {
  location: {
    projectId: ReferenceExpression
  }
}

const isBoardWithProjectId = (element: InstanceElement): element is InstanceElement & { value: BoardWithProjectId } =>
  element.elemID.typeName === BOARD_TYPE_NAME && isReferenceExpression(element.value.location?.projectId)

type AutomationWithProjectId = {
  projects: {
    projectId?: ReferenceExpression
  }[]
}

const isAutomationWithProjectId = (
  element: InstanceElement,
): element is InstanceElement & { value: AutomationWithProjectId } =>
  element.elemID.typeName === AUTOMATION_TYPE &&
  Array.isArray(element.value.projects) &&
  element.value.projects.some((projectInfo: { projectId: unknown }) => isReferenceExpression(projectInfo.projectId))

type ContextWithProjectIds = {
  projectIds: ReferenceExpression[]
}

const isContextWithProjectIds = (
  element: InstanceElement,
): element is InstanceElement & { value: ContextWithProjectIds } =>
  element.elemID.typeName === FIELD_CONTEXT_TYPE_NAME &&
  Array.isArray(element.value.projectIds) &&
  element.value.projectIds.every(isReferenceExpression)

type ProjectScopeInfo = {
  instance: InstanceElement
  projectKeys: Set<string>
}

const getDescendants = (
  instance: InstanceElement,
  instanceFullNameToChildren: Record<string, InstanceElement[]>,
  visitedDescendants: Set<string>,
): InstanceElement[] => {
  const instanceChildren = []
  const instancesToWalkOn = [instance]
  const newVisitedDescendants = new Set<string>(visitedDescendants)

  while (instancesToWalkOn.length > 0) {
    const currentInstance = instancesToWalkOn.pop()!
    newVisitedDescendants.add(currentInstance.elemID.getFullName())
    const currentChildren = instanceFullNameToChildren[currentInstance.elemID.getFullName()]
    if (currentChildren !== undefined) {
      const childrenToWalkOn = currentChildren.filter(child => !newVisitedDescendants.has(child.elemID.getFullName()))
      instanceChildren.push(...childrenToWalkOn)
      instancesToWalkOn.push(...childrenToWalkOn)
    }
  }
  return instanceChildren
}

// This function is used to get all the instances that are referenced from a project (not including other projects)
// This function changes the instancesToWalkOn and instanceScope arguments by reference
const getProjectReferences = ({
  instance,
  instancesToWalkOn,
  instanceScope,
  fullNameToInstance,
}: {
  instance: InstanceElement
  instancesToWalkOn: InstanceElement[]
  instanceScope: Record<string, ElemID>
  fullNameToInstance: Record<string, InstanceElement>
}): void => {
  walkOnValue({
    elemId: instance.elemID,
    value: instance.value,
    func: ({ value, path }) => {
      if (isResolvedReferenceExpression(value)) {
        if (path.typeName === FIELD_TYPE && value.elemID.typeName === FIELD_CONTEXT_TYPE_NAME) {
          const contextValue = value.value.value
          // we don't want to add other projects contexts to the project scope,
          // therefore we skip all contexts that are not global.
          // the project contexts are handled in the context section (addContextsToProjectScope)
          if (makeArray(contextValue.projectIds).length > 0) return WALK_NEXT_STEP.SKIP
        }
        // we don't want to add other projects to the project scope, in addition it might cause an infinite loop
        if (value.elemID.typeName === PROJECT_TYPE) return WALK_NEXT_STEP.SKIP
        if (instanceScope[value.elemID.getFullName()] === undefined) {
          instanceScope[value.elemID.getFullName()] = value.elemID
          // handle references to not top level elements
          const instanceToWalkOn = isInstanceElement(value.value)
            ? value.value
            : fullNameToInstance[value.elemID.createTopLevelParentID().parent.getFullName()]
          if (instanceToWalkOn === undefined) {
            log.error(
              `Instance to walk on is undefined for ${value.elemID.getFullName()}. The projects scope is incomplete for instance ${instance.elemID.getFullName()}`,
            )
            return WALK_NEXT_STEP.SKIP
          }
          instancesToWalkOn.push(instanceToWalkOn)
        }
        return WALK_NEXT_STEP.SKIP
      }
      return WALK_NEXT_STEP.RECURSE
    },
  })
}

// for each project we retrieve all the instances that this project tree contains.
// It is done by walking on the project and its children.
// We gather all the instances that are referenced from the project and its children.
const getProjectScope = (
  instances: InstanceElement[],
  instanceFullNameToChildren: Record<string, InstanceElement[]>,
  fullNameToInstance: Record<string, InstanceElement>,
): ElemID[] => {
  // fullNameToElemId is the project scope
  const fullNameToElemId = Object.fromEntries(
    instances.map(instance => [instance.elemID.getFullName(), instance.elemID]),
  )
  const visitedDescendants = new Set<string>()
  while (instances.length > 0) {
    const currentInstance = instances.pop()!

    const descendants = getDescendants(currentInstance, instanceFullNameToChildren, visitedDescendants)
    descendants.forEach(descendant => {
      fullNameToElemId[descendant.elemID.getFullName()] = descendant.elemID
      instances.push(descendant)
      visitedDescendants.add(descendant.elemID.getFullName())
    })
    getProjectReferences({
      instance: currentInstance,
      instancesToWalkOn: instances,
      instanceScope: fullNameToElemId,
      fullNameToInstance,
    })
  }
  return Object.values(fullNameToElemId)
}

const addBoardsToProjectScope = (
  instances: InstanceElement[],
  projectFullNameToScope: Record<string, InstanceElement[]>,
): void => {
  instances.filter(isBoardWithProjectId).forEach(board => {
    addOrUpdate(projectFullNameToScope, board.value.location.projectId.elemID.getFullName(), board)
  })
}

const addAutomationsToProjectScope = (
  instances: InstanceElement[],
  projectFullNameToScope: Record<string, InstanceElement[]>,
): void => {
  instances.filter(isAutomationWithProjectId).forEach(automation => {
    automation.value.projects.forEach(automationProject => {
      const projectRef = automationProject.projectId
      if (!isReferenceExpression(projectRef)) {
        return
      }
      addOrUpdate(projectFullNameToScope, projectRef.elemID.getFullName(), automation)
    })
  })
}

const addContextsToProjectScope = (
  instances: InstanceElement[],
  projectFullNameToScope: Record<string, InstanceElement[]>,
): void => {
  instances.filter(isContextWithProjectIds).forEach(context => {
    context.value.projectIds.forEach(projectId => {
      addOrUpdate(projectFullNameToScope, projectId.elemID.getFullName(), context)
    })
  })
}

const getProjectFullNameToScope = (instances: InstanceElement[]): Record<string, InstanceElement[]> => {
  const projectFullNameToScope: Record<string, InstanceElement[]> = {}
  const addInstancesToProjectScopeFuncs = [
    addBoardsToProjectScope,
    addAutomationsToProjectScope,
    addContextsToProjectScope,
  ]
  addInstancesToProjectScopeFuncs.forEach(addInstancesToProjectScopeFunc => {
    addInstancesToProjectScopeFunc(instances, projectFullNameToScope)
  })
  Object.entries(projectFullNameToScope).forEach(([projectFullName, scope]) => {
    projectFullNameToScope[projectFullName] = _.uniqBy(scope, instance => instance.elemID.getFullName())
  })
  return projectFullNameToScope
}

const getInstanceFullNameToChildren = (instances: InstanceElement[]): Record<string, InstanceElement[]> =>
  _.chain(instances)
    .filter(instance => getParentOrUndefined(instance) !== undefined)
    .groupBy(instance => getParent(instance).elemID.getFullName())
    .value()

const getProjectsScopeInfo = (
  instances: InstanceElement[],
  projectFullNameToScope: Record<string, InstanceElement[]>,
): ProjectScopeInfo[] => {
  const instanceNameToProjectScopeInfo: Record<string, ProjectScopeInfo> = Object.fromEntries(
    instances.map(instance => [
      instance.elemID.getFullName(),
      {
        instance,
        projectKeys: new Set(),
      },
    ]),
  )
  const fullNameToInstance = Object.fromEntries(instances.map(instance => [instance.elemID.getFullName(), instance]))
  const instanceFullNameToChildren = getInstanceFullNameToChildren(instances)

  instances
    .filter(instance => instance.elemID.typeName === PROJECT_TYPE)
    .forEach(project => {
      const instancesReferringToProject = makeArray(projectFullNameToScope[project.elemID.getFullName()])
      instancesReferringToProject.push(project)
      const scope = getProjectScope(instancesReferringToProject, instanceFullNameToChildren, fullNameToInstance)
      scope.forEach(elemId => {
        const topLevelElemId = elemId.createTopLevelParentID().parent
        const fullName = topLevelElemId.getFullName()
        if (instanceNameToProjectScopeInfo[fullName]?.projectKeys !== undefined) {
          instanceNameToProjectScopeInfo[fullName].projectKeys.add(project.value.key)
        }
      })
    })
  return Object.values(instanceNameToProjectScopeInfo)
}

const createProjectScopeField = (objectType: ObjectType): Field =>
  new Field(objectType, PROJECT_SCOPE_FIELD_NAME, new ListType(BuiltinTypes.STRING), {
    [CORE_ANNOTATIONS.HIDDEN_VALUE]: true,
  })

const addProjectScopeToObjectTypes = (instances: InstanceElement[]): void => {
  const objectTypes = _.uniqBy(
    instances.map(instance => instance.getTypeSync()),
    objectType => objectType.elemID.getFullName(),
  )

  objectTypes.forEach(objectType => {
    objectType.fields[PROJECT_SCOPE_FIELD_NAME] = createProjectScopeField(objectType)
  })
}

/**
 * This filter adds a hidden field called projectsScope which is a list of projects keys that the instance is in scope of.
 * The scope is determined by:
 * - references from projects (recursively)
 * - project children (recursively)
 * - Boards, CustomFieldContext and Automation that referring the project
 */
const filter: FilterCreator = ({ config }) => ({
  name: 'projectScopeFilter',
  onFetch: async (elements: Element[]) => {
    if (!config.fetch.enableProjectsScope) {
      return
    }
    const instances = elements.filter(isInstanceElement)
    addProjectScopeToObjectTypes(instances)

    const projectFullNameToScope = getProjectFullNameToScope(instances)
    const projectsScopeInfo = getProjectsScopeInfo(instances, projectFullNameToScope)

    // Add projectScope field to all relevant instances
    projectsScopeInfo.forEach(scopeInfo => {
      if (scopeInfo.projectKeys.size > 0) {
        log.trace(
          `adding projectsScope to ${scopeInfo.instance.elemID.getFullName()} with value: ${scopeInfo.projectKeys}`,
        )
        scopeInfo.instance.value.projectsScope = Array.from(scopeInfo.projectKeys)
      }
    })
  },
})

export default filter
