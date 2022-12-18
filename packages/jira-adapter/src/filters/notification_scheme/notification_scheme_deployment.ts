/*
*                      Copyright 2022 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import { Change, Element, getChangeData, InstanceElement, isAdditionOrRemovalChange, isInstanceChange, isModificationChange, isRemovalOrModificationChange, ReferenceExpression } from '@salto-io/adapter-api'
import { logger } from '@salto-io/logging'
import _ from 'lodash'
import Joi from 'joi'
import { safeJsonStringify } from '@salto-io/adapter-utils'
import { findObject, setFieldDeploymentAnnotations, setTypeDeploymentAnnotations } from '../../utils'
import { FilterCreator } from '../../filter'
import { NOTIFICATION_EVENT_TYPE_NAME, NOTIFICATION_SCHEME_TYPE_NAME } from '../../constants'
import { defaultDeployChange, deployChanges } from '../../deployment/standard_deployment'
import { deployEvents } from './notification_events'

const log = logger(module)

type NotificationEvent = {
  event?: unknown
  eventType?: ReferenceExpression
  notifications?: {
    type?: string
    notificationType?: string
    user?: unknown
    additionalProperties?: unknown
  }[]
}

const NOTIFICATION_SCHEME_EVENT = Joi.object({
  eventType: Joi.any(),
}).unknown(true)


const isNotificationSchemeEvent = (value: unknown): value is NotificationEvent => {
  const { error } = NOTIFICATION_SCHEME_EVENT.validate(value)
  if (error !== undefined) {
    log.error(`Received an invalid notification scheme event: ${error.message}, ${safeJsonStringify(value)}`)
    return false
  }
  return true
}


const filter: FilterCreator = ({ client, config }) => ({
  onFetch: async (elements: Element[]) => {
    if (!config.client.usePrivateAPI) {
      log.debug('Skipping notification scheme deployment filter because private API is not enabled')
      return
    }

    const notificationSchemeType = findObject(elements, NOTIFICATION_SCHEME_TYPE_NAME)
    if (notificationSchemeType !== undefined) {
      setTypeDeploymentAnnotations(notificationSchemeType)
      setFieldDeploymentAnnotations(notificationSchemeType, 'id')
      setFieldDeploymentAnnotations(notificationSchemeType, 'name')
      setFieldDeploymentAnnotations(notificationSchemeType, 'description')
      setFieldDeploymentAnnotations(notificationSchemeType, 'notificationSchemeEvents')
    }

    const notificationEventType = findObject(elements, NOTIFICATION_EVENT_TYPE_NAME)
    if (notificationEventType !== undefined) {
      setFieldDeploymentAnnotations(notificationEventType, 'eventType')
      setFieldDeploymentAnnotations(notificationEventType, 'notifications')
      delete notificationEventType.fields.event
      delete notificationEventType.fields.notifications
    }
  },

  deploy: async changes => {
    if (client.isDataCenter) {
      return {
        leftoverChanges: changes,
        deployResult: {
          appliedChanges: [],
          errors: [],
        },
      }
    }
    const [relevantChanges, leftoverChanges] = _.partition(
      changes,
      change => isInstanceChange(change)
        && getChangeData(change).elemID.typeName === NOTIFICATION_SCHEME_TYPE_NAME
    )

    const deployResult = await deployChanges(
      relevantChanges as Change<InstanceElement>[],
      async change => {
        await defaultDeployChange({
          change,
          client,
          apiDefinitions: config.apiDefinitions,
          fieldsToIgnore: isAdditionOrRemovalChange(change)
            ? []
            : [NOTIFICATION_EVENT_TYPE_NAME],
        })
      }
    )

    const eventsDeployResult = await deployChanges(
      deployResult.appliedChanges
        .filter(isModificationChange)
        .filter(isInstanceChange),

      change => deployEvents(
        change,
        client,
      )
    )

    return {
      leftoverChanges,
      deployResult: {
        appliedChanges: [
          ...deployResult.appliedChanges,
          ...eventsDeployResult.appliedChanges,
        ],
        errors: [
          ...deployResult.errors,
          ...eventsDeployResult.errors,
        ],
      },
    }
  },

  preDeploy: async changes => {
    if (client.isDataCenter) {
      return
    }
    changes
      .filter(isInstanceChange)
      .filter(change => getChangeData(change).elemID.typeName === NOTIFICATION_SCHEME_TYPE_NAME)
      .forEach(change => {
        const instance = getChangeData(change)
        const { notificationSchemeEvents } = instance.value
        if (notificationSchemeEvents !== undefined) {
          notificationSchemeEvents.filter(isNotificationSchemeEvent)
            .forEach(async (event: NotificationEvent) => {
              if (event.eventType !== undefined) {
                event.event = event.eventType
                event.notifications?.forEach(notification => {
                  if (notification.type !== undefined) {
                    notification.notificationType = notification.type
                  }
                })
              }
            })
        }
        if (isRemovalOrModificationChange(change)) {
          instance.value.schemeId = instance.value.id
        }
      })
  },

  onDeploy: async changes => {
    if (client.isDataCenter) {
      return
    }
    changes
      .filter(isInstanceChange)
      .filter(change => getChangeData(change).elemID.typeName === NOTIFICATION_SCHEME_TYPE_NAME)
      .forEach(change => {
        const instance = getChangeData(change)
        instance.value.id = Number(instance.value.id)
        const { notificationSchemeEvents } = instance.value
        if (notificationSchemeEvents !== undefined) {
          notificationSchemeEvents.filter(isNotificationSchemeEvent)
            .forEach(async (event: NotificationEvent) => {
              event.notifications?.forEach(notification => {
                delete notification.notificationType
              })
              delete event.event
            })
        }
        if (isRemovalOrModificationChange(change)) {
          delete instance.value.schemeId
        }
      })
  },
})

export default filter
